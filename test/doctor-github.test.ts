import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import {
  check,
  githubReads,
  withDoctor,
  withDoctorWorkflow,
} from "./doctor-fixture.ts";

await test("CLV-207 GitHub login, origin and bot activity are read only", () =>
  withDoctor(async (scene) => {
    const output = await scene.report();
    for (const code of ["gh-login", "github-origin", "greptile-review"])
      assert.equal(check(output, code)["result"], "ok", code);
    assert.match(
      String(check(output, "greptile-review")["detail"]),
      /activity.*usable review/i,
    );
    const reads = await githubReads(scene);
    assert.match(reads, /auth.*status/);
    assert.match(reads, /pr.*list.*20/);
    assert.doesNotMatch(reads, /create|edit|merge|POST|PATCH/);
  }));

await test("CLV-207 configured GitHub command is used even when plain gh fails", () =>
  withDoctor(async (scene) => {
    const path = await scene.program(
      "custom-gh",
      'if (process.argv[2] === "auth") process.exit(0); console.log("[]")',
    );
    await scene.program("gh", "process.exit(1)");
    const output = await scene.report({
      CLOVING_GH_COMMAND: JSON.stringify([path]),
    });
    assert.equal(check(output, "gh-login")["result"], "ok");
    assert.equal(check(output, "greptile-review")["result"], "skip");
  }));

await test("CLV-207 login failures skip dependent GitHub reads and name the configured repair", () =>
  withDoctor(async (scene) => {
    const path = await scene.program("custom-gh", "process.exit(1)");
    const output = await scene.report({
      CLOVING_GH_COMMAND: JSON.stringify([path]),
    });
    assert.equal(check(output, "gh-login")["result"], "fail");
    assert.match(
      String(check(output, "gh-login")["fix"]),
      /custom-gh.*auth login/,
    );
    assert.equal(check(output, "greptile-review")["result"], "skip");
  }));

await test("CLV-207 a local origin fails without contacting it", () =>
  withDoctor(async (scene) => {
    execFileSync("git", [
      "-C",
      scene.repository,
      "remote",
      "set-url",
      "origin",
      "file:///local/project.git",
    ]);
    const output = await scene.report();
    assert.equal(check(output, "github-origin")["result"], "fail");
    assert.match(
      String(check(output, "github-origin")["fix"]),
      /remote set-url origin/,
    );
    assert.equal(check(output, "greptile-review")["result"], "skip");
  }));

for (const origin of [
  "git@github.example.test:example/project.git",
  "https://github.example.test/example/project.git",
])
  await test(`CLV-207 Enterprise origin ${origin} scopes login and every GitHub read to its host`, () =>
    withDoctorWorkflow(async (scene) => {
      execFileSync("git", [
        "-C",
        scene.repository,
        "remote",
        "set-url",
        "origin",
        origin,
      ]);
      const configured = await scene.program(
        "enterprise-gh",
        `
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
const arguments_ = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(scene.root, "github-reads"))}, JSON.stringify(arguments_) + "\\n");
const [command, subcommand] = arguments_;
if (command === "pr") {
  assert.equal(subcommand, "list");
  assert.equal(arguments_[arguments_.indexOf("--repo") + 1], "github.example.test/example/project");
  console.log('[{"number":1}]');
} else {
  assert.equal(arguments_[arguments_.indexOf("--hostname") + 1], "github.example.test");
  if (command === "auth") {
    assert.equal(subcommand, "status");
  } else {
    assert.equal(command, "api");
    assert.equal(arguments_[arguments_.indexOf("--method") + 1], "GET");
    console.log(arguments_.at(-1).includes("pulls/1/comments") ? '[{"user":{"login":"greptile-apps[bot]"}}]' : '[]');
  }
}
`,
      );
      await scene.program("gh", "process.exit(91)");
      const output = await scene.report({
        CLOVING_GH_COMMAND: JSON.stringify([configured]),
        GH_HOST: "unrelated.example.test",
      });
      for (const code of ["github-origin", "gh-login", "greptile-review"])
        assert.equal(check(output, code)["result"], "ok", code);
      assert.match(
        String(check(output, "github-origin")["detail"]),
        /github\.example\.test/,
      );
      const reads = await githubReads(scene);
      assert.equal(reads.trim().split("\n").length, 5);
      for (const endpoint of [
        "pulls/1/reviews",
        "issues/1/comments",
        "pulls/1/comments",
      ])
        assert.ok(reads.includes(endpoint), endpoint);
      assert.equal(output.status, 0);
    }));

await test("CLV-207 Enterprise login failures name a repair for the origin host and skip dependent reads", () =>
  withDoctor(async (scene) => {
    execFileSync("git", [
      "-C",
      scene.repository,
      "remote",
      "set-url",
      "origin",
      "git@github.example.test:example/project.git",
    ]);
    const configured = await scene.program("enterprise-gh", "process.exit(1)");
    const output = await scene.report({
      CLOVING_GH_COMMAND: JSON.stringify([configured]),
    });
    assert.equal(check(output, "gh-login")["result"], "fail");
    assert.match(
      String(check(output, "gh-login")["fix"]),
      /enterprise-gh.*auth login --hostname github\.example\.test/,
    );
    assert.equal(check(output, "greptile-review")["result"], "skip");
    assert.equal(output.status, 1);
  }));

await test("CLV-207 no pull requests skips Greptile with an installation and first PR fix", () =>
  withDoctor(async (scene) => {
    await scene.program(
      "gh",
      'if (process.argv[2] === "auth") process.exit(0); console.log("[]")',
    );
    const item = check(await scene.report(), "greptile-review");
    assert.equal(item["result"], "skip");
    assert.match(String(item["fix"]), /Install.*Greptile.*first pull request/s);
  }));

await test("CLV-207 missing bot activity fails without claiming the app is absent", () =>
  withDoctor(async (scene) => {
    await scene.program(
      "gh",
      'if (process.argv[2] === "auth") process.exit(0); console.log(process.argv[2] === "pr" ? "[{\\"number\\":1}]" : "[]")',
    );
    const item = check(await scene.report(), "greptile-review");
    assert.equal(item["result"], "fail");
    assert.match(String(item["detail"]), /does not prove.*not installed/i);
  }));

await test("CLV-207 GitHub reads fail within ten seconds", () =>
  withDoctor(async (scene) => {
    await scene.program("gh", "setInterval(() => {}, 1000)");
    const started = performance.now();
    const item = check(await scene.report(), "gh-login");
    assert.equal(item["result"], "fail");
    assert.match(String(item["detail"]), /10 seconds|timed out/);
    assert.ok(performance.now() - started < 14000);
  }));

await test("CLV-207 a configured GitHub repair command quotes shell metacharacters literally", () =>
  withDoctor(async (scene) => {
    const path = await scene.program("custom $ gh", "process.exit(1)");
    const output = await scene.report({
      CLOVING_GH_COMMAND: JSON.stringify([path]),
    });
    assert.match(
      String(check(output, "gh-login")["fix"]),
      /'[^']*custom \$ gh' auth login/,
    );
  }));
