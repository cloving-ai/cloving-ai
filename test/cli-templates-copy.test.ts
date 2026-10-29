import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { cliOptions, entry } from "./cli-workflows-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { record } from "../src/protocol.ts";
import {
  filesBelow,
  repository,
  templateFiles,
  templates,
} from "./cli-templates-fixture.ts";

for (const present of [
  "develop.ts",
  "develop/turn.ts",
  "develop.declaration.json",
])
  await test(`CLV-223 templates copy over an existing ${present} leaves only the files that were present`, () =>
    withFiles(
      { ...repository, [`repo/.cloving/workflows/${present}`]: "changed" },
      async (root) => {
        const folder = join(root, "repo/.cloving/workflows");
        const again = templates(root, ["copy", "develop"]);
        assert.equal(again.status, 1);
        assert.match(again.stderr, /workflow-exists/);
        assert.deepEqual(await filesBelow(folder), [present]);
        assert.equal(await readFile(join(folder, present), "utf8"), "changed");
      },
    ));

await test("CLV-223 templates copy over a complete copy changes no file", () =>
  withFiles(repository, async (root) => {
    assert.equal(templates(root, ["copy", "develop"]).status, 0);
    const folder = join(root, "repo/.cloving/workflows");
    await writeFile(join(folder, "develop.ts"), "changed");
    const before = await filesBelow(folder);
    const again = templates(root, ["copy", "develop"]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /workflow-exists/);
    assert.deepEqual(await filesBelow(folder), before);
    assert.equal(await readFile(join(folder, "develop.ts"), "utf8"), "changed");
  }));

await test("CLV-223 two copies at the same time leave one complete copy", () =>
  withFiles(repository, async (root) => {
    const run = () =>
      new Promise<{ status: number | null; stderr: string }>((settle) => {
        const child = spawn(
          process.execPath,
          [entry, "templates", "copy", "develop"],
          cliOptions(root),
        );
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += String(chunk);
        });
        child.once("close", (status) => {
          settle({ status, stderr });
        });
      });
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      [0, 1],
      JSON.stringify(results),
    );
    assert.match(
      results.find((result) => result.status === 1)?.stderr ?? "",
      /workflow-exists/,
    );
    const expected = await templateFiles();
    assert.deepEqual(
      await filesBelow(join(root, "repo/.cloving/workflows")),
      expected,
    );
  }));

await test("CLV-223 templates copy prints JSON and ignores unreadable declarations", () =>
  withFiles(
    {
      ...repository,
      "repo/.cloving/workflows/broken.declaration.json": "{",
      "repo/.cloving/workflows/folder.declaration.json/.gitkeep": "",
    },
    (root) => {
      const result = templates(root, [
        "copy",
        "develop",
        "--json",
        "--repository",
        join(root, "repo"),
      ]);
      assert.equal(result.status, 0, result.stderr);
      const printed = record(JSON.parse(result.stdout));
      assert.equal(printed?.["workflowId"], "develop");
      assert.equal(printed["template"], "develop");
      assert.deepEqual(printed["queueWorkflows"], ["develop"]);
      const files = printed["files"];
      assert.ok(Array.isArray(files) && files.includes("develop.ts"));
      assert.doesNotMatch(result.stderr, /queue-workflow-conflict/);
    },
  ));

const developDeclaration = await readFile(
  "templates/develop/develop.declaration.json",
  "utf8",
);

await test("CLV-223 copied function names avoid reserved words and names of other workflows", () =>
  withFiles(repository, async (root) => {
    const folder = join(root, "repo/.cloving/workflows");
    for (const [id, name] of [
      ["delete", "deleteWorkflow"],
      ["dev-1", "dev1"],
      ["dev1", "dev1Workflow"],
      ["develop-ticket", "developTicketWorkflow"],
    ] as const) {
      const copied = templates(root, ["copy", "develop", "--id", id]);
      assert.equal(copied.status, 0, copied.stderr);
      assert.match(
        await readFile(join(folder, `${id}.ts`), "utf8"),
        new RegExp(`export async function ${name}\\(`),
        id,
      );
    }
  }));

await test("CLV-223 templates copy reads the settings before it writes a file", () =>
  withFiles(
    { ...repository, "repo/.cloving/config.json": "{" },
    async (root) => {
      const copied = templates(root, ["copy", "develop"]);
      assert.equal(copied.status, 1);
      assert.doesNotMatch(copied.stderr, /workflow-exists/);
      assert.deepEqual(await filesBelow(join(root, "repo/.cloving")), [
        "config.json",
      ]);
    },
  ));

await test("CLV-223 templates copy reports a write error with its own cause", () =>
  withFiles(
    { ...repository, "repo/.cloving/workflows/.gitkeep": "" },
    async (root) => {
      const folder = join(root, "repo/.cloving/workflows");
      await chmod(folder, 0o555);
      try {
        const copied = templates(root, ["copy", "develop"]);
        assert.equal(copied.status, 1);
        assert.doesNotMatch(copied.stderr, /workflow-exists/);
        assert.match(copied.stderr, /EACCES|permission/i);
      } finally {
        await chmod(folder, 0o755);
      }
      assert.deepEqual(await filesBelow(folder), [".gitkeep"]);
    },
  ));

await test("CLV-223 the queue warning counts only declarations that discovery admits", () =>
  withFiles(
    {
      ...repository,
      "repo/.cloving/workflows/old.declaration.json":
        developDeclaration.replace(
          '"workflowId": "develop"',
          '"workflowId": "old"',
        ),
      "repo/.cloving/workflows/bad.ts": "export async function bad() {}\n",
      "repo/.cloving/workflows/bad.declaration.json": JSON.stringify({
        workflow: { workflowId: "bad", queue: true },
      }),
    },
    (root) => {
      const copied = templates(root, ["copy", "develop", "--json"]);
      assert.equal(copied.status, 0, copied.stderr);
      assert.doesNotMatch(copied.stderr, /queue-workflow-conflict/);
      assert.deepEqual(record(JSON.parse(copied.stdout))?.["queueWorkflows"], [
        "develop",
      ]);
    },
  ));
