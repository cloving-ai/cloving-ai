import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitFiles,
  runs,
  testFile,
  verdict,
  withRedGreen,
} from "./red-green-fixture.ts";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { git } from "./claude-worker-fixture.ts";
import { redGreen } from "./red-green-fixture.ts";

await test("CLV-248 stderr supplies assertion evidence and is retained with stdout", () =>
  withRedGreen(
    {
      red: { status: 1, output: "", stderr: "ERR_ASSERTION on stderr" },
      green: { status: 1, output: "green stdout", stderr: "green stderr" },
    },
    (scene) => {
      const result = verdict(scene, "green-failed");
      assert.match(String(result["output"]), /green stdout/);
      assert.match(String(result["output"]), /green stderr/);
    },
  ));

await test("CLV-248 a test that passes on the base gives false-red", () =>
  withRedGreen(
    {
      red: { status: 0, output: "red passed" },
      green: { status: 0, output: "green passed" },
    },
    (scene) => {
      const result = verdict(scene, "false-red");
      assert.equal(result["output"], "red passed");
      assert.deepEqual(runs(scene), [
        { phase: "red", files: [testFile] },
        { phase: "green", files: [testFile] },
      ]);
    },
  ));

await test("CLV-248 node --test default patterns detect assertions, imports and skips", async () => {
  const cases = [
    [
      "accepted",
      'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; assert.equal(readFileSync("src/sum.ts", "utf8"), "head");',
    ],
    ["red-not-assertion", 'import "../src/new-module.mjs";'],
    [
      "skipped-test",
      'import { test } from "node:test"; test("sample", { skip: true }, () => {});',
    ],
  ];
  for (const [expected = "", source = ""] of cases) {
    await withRedGreen(
      { red: { status: 0, output: "" }, green: { status: 0, output: "" } },
      (scene) => {
        const head = commitFiles(scene, {
          [testFile]: source,
          "src/new-module.mjs": "export {};",
        });
        const result = verdict(
          {
            ...scene,
            head,
            settings: {
              test: [process.execPath, "--test"],
              testFiles: ["test/"],
            },
          },
          expected,
        );
        assert.equal(typeof result["output"], "string");
      },
    );
  }
});

await test("CLV-248 configured patterns decide before output is limited to its last 16000 characters", () =>
  withRedGreen(
    {
      red: { status: 1, output: "ASSERT custom\n" + "r".repeat(17000) },
      green: { status: 0, output: "pass" },
    },
    (scene) => {
      const configured = {
        ...scene,
        settings: { ...scene.settings, assertionPattern: "^ASSERT custom" },
      };
      assert.equal(verdict(configured, "accepted")["output"], "pass");
      const skipped = {
        ...configured,
        settings: { ...configured.settings, skipPattern: "^ASSERT custom" },
      };
      assert.equal(
        verdict(skipped, "skipped-test")["output"],
        "r".repeat(16000),
      );
    },
  ));

await test("CLV-248 no added or changed test gives no-test-change without commands", () =>
  withRedGreen(
    {
      red: { status: 0, output: "pass" },
      green: { status: 0, output: "pass" },
    },
    (scene) => {
      git(scene.repository, [
        "update-ref",
        "refs/remotes/origin/main",
        scene.head,
      ]);
      rmSync(join(scene.repository, testFile));
      const head = commitFiles(scene, { "src/sum.ts": "changed" });
      const result = redGreen(
        { ...scene, head },
        { settings: { ...scene.settings, prepare: ["missing-prepare"] } },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        verdict: "no-test-change",
        base: scene.head,
        head,
        files: [],
        output: "",
      });
      assert.deepEqual(runs(scene), []);
      assert.equal(
        git(scene.repository, ["worktree", "list", "--porcelain"]).split(
          "worktree ",
        ).length,
        2,
      );
    },
  ));

await test("CLV-248 prepare runs in both trees and its failure takes priority", async () => {
  for (const phase of ["base", "head"]) {
    await withRedGreen(
      {
        red: { status: 0, output: "# SKIP" },
        green: { status: 0, output: "pass" },
      },
      (scene) => {
        const head = commitFiles(scene, {
          "prepare.mjs": `import { readFileSync } from "node:fs";\nconst phase = readFileSync("src/sum.ts", "utf8");\nconsole.log("prepare " + phase);\nprocess.exitCode = phase === ${JSON.stringify(phase)} ? 1 : 0;\n`,
        });
        const basePrepare = [
          process.execPath,
          "-e",
          `const phase=require("node:fs").readFileSync("src/sum.ts","utf8");console.log("prepare "+phase);process.exitCode=phase===${JSON.stringify(phase)}?1:0;`,
        ];
        const configured = {
          ...scene,
          head,
          settings: { ...scene.settings, prepare: basePrepare },
        };
        assert.equal(
          verdict(configured, "prepare-failed")["output"],
          `prepare ${phase}\n`,
        );
        assert.deepEqual(runs(scene), [
          { phase: phase === "base" ? "green" : "red", files: [testFile] },
        ]);
      },
    );
  }
});

await test("CLV-248 a skipped test in either run takes priority over test exits", async () => {
  for (const phase of ["red", "green"]) {
    await withRedGreen(
      {
        red: { status: 0, output: "red passed" },
        green: { status: 1, output: "green error" },
        [phase]: { status: 0, output: "ok 1 - sample # SKIP reason" },
      },
      (scene) => {
        assert.equal(
          verdict(scene, "skipped-test")["output"],
          "ok 1 - sample # SKIP reason",
        );
      },
    );
  }
});

await test("CLV-248 an assertion red and failing head gives green-failed", () =>
  withRedGreen(
    {
      red: { status: 1, output: "ERR_ASSERTION red" },
      green: { status: 7, output: "green error" },
    },
    (scene) => {
      assert.equal(verdict(scene, "green-failed")["output"], "green error");
    },
  ));

await test("CLV-248 a base import or build error gives red-not-assertion", () =>
  withRedGreen(
    {
      red: { status: 1, output: "ERR_MODULE_NOT_FOUND" },
      green: { status: 1, output: "green error" },
    },
    (scene) => {
      assert.equal(
        verdict(scene, "red-not-assertion")["output"],
        "ERR_MODULE_NOT_FOUND",
      );
    },
  ));

await test("CLV-248 assertion failure on base and pass on head gives accepted", () =>
  withRedGreen(
    {
      red: { status: 1, output: "ERR_ASSERTION red" },
      green: { status: 0, output: "green passed" },
    },
    (scene) => {
      assert.equal(verdict(scene, "accepted")["output"], "green passed");
    },
  ));
