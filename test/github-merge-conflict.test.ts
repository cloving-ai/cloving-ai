import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, resultOf } from "./claude-worker-fixture.ts";
import {
  committed,
  opened,
  treeOf,
  withGithub,
  type GithubScene,
} from "./github-worker-fixture.ts";
import { mergeCalls } from "./github-merge-fixture.ts";

function conflictingLane(
  scene: GithubScene,
  options: { readonly padding?: number } = {},
): void {
  git(scene.repository, ["checkout", "--quiet", "-b", "other-lane"]);
  committed(scene.repository, { name: "one.ts", text: "2;\n" });
  git(scene.repository, ["checkout", "--quiet", "main"]);
  git(scene.repository, [
    "merge",
    "--quiet",
    "--no-ff",
    "--no-edit",
    "other-lane",
  ]);
  git(scene.repository, ["push", "--quiet", "origin", "main"]);
  const driver = join(scene.directory, "merge-driver.mjs");
  writeFileSync(
    driver,
    `process.stderr.write("fixture-token\\nfixture-private" + "x".repeat(${String(options.padding ?? 0)}) + "\\n"); process.exitCode = 1;`,
  );
  git(treeOf(scene), [
    "config",
    "merge.fixture.driver",
    `${JSON.stringify(process.execPath)} ${JSON.stringify(driver)}`,
  ]);
  writeFileSync(
    git(treeOf(scene), ["rev-parse", "--git-path", "info/attributes"]),
    "src/one.ts merge=fixture\n",
  );
}

await test("CLV-184 another lane merging first returns conflict output for a fix round", () =>
  withGithub(async (scene) => {
    const trace = join(scene.directory, "git-trace");
    const worker = scene.worker({
      privateTexts: ["fixture-private"],
      environment: {
        FAKE_GH_STATE: join(scene.directory, "gh-state.json"),
        FAKE_GH_ORIGIN: scene.origin,
        GIT_TRACE: trace,
        SAMPLE_TOKEN: "fixture-token",
      },
    });
    const commit = await opened(scene, worker);
    conflictingLane(scene);
    writeFileSync(trace, "");
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.outcome, "completed", report.reason ?? "");
    const repair = resultOf(report.result);
    assert.equal(repair["reason"], "merge-conflict");
    assert.match(String(repair["output"]), /CONFLICT.*src\/one\.ts/);
    assert.doesNotMatch(
      String(repair["output"]),
      /fixture-private|fixture-token/,
    );
    assert.match(String(repair["output"]), /\[hidden\]/);
    assert.deepEqual(mergeCalls(scene), []);
    assert.doesNotMatch(readFileSync(trace, "utf8"), /built-in: git push/);
    assert.equal(git(treeOf(scene), ["rev-parse", "HEAD"]), commit);
    assert.equal(
      existsSync(git(treeOf(scene), ["rev-parse", "--git-path", "MERGE_HEAD"])),
      false,
    );
    assert.equal(
      git(scene.origin, ["rev-parse", "cloving/ticket-one"]),
      commit,
    );
    assert.equal(
      scene.state().calls.some((call) => call.includes("PUT")),
      false,
    );
  }));

await test("CLV-184 conflict diagnostics redact secrets before truncating output", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({
      privateTexts: ["fixture-private", "fixture-token"],
    });
    const commit = await opened(scene, worker);
    conflictingLane(scene, { padding: 5980 });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    const repair = resultOf(report.result);
    assert.equal(repair["reason"], "merge-conflict");
    const output = String(repair["output"]);
    assert.ok(output.length <= 6000);
    assert.doesNotMatch(output, /private|fixture-token/);
    assert.match(output, /\[hidden\]/);
  }));
