import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { field, parsed, waitingGate, withHarness } from "./service-fixture.ts";
import { watchedModel } from "./watch-fixture.ts";
import { component } from "../src/cli/watch-element.ts";
import { Page } from "../src/cli/watch-view.ts";
import { rendered } from "./watch-dom.ts";
import { sampleModel, sampleRun, at, noCopy } from "./watch-sample.ts";
import { ciRerunNotices } from "../src/cli/github-ci-progress.ts";

await test("CLV-198 rerun notices ignore incomplete and malformed private records", async () => {
  const folder = await mkdtemp(join(tmpdir(), "cloving-ci-notices-"));
  const file = join(folder, `ci-${"a".repeat(32)}.json`);
  try {
    await writeFile(join(folder, "unrelated.json"), "{}");
    for (const content of [
      "not json",
      "{}",
      JSON.stringify({ commit: "invalid", reruns: [] }),
      JSON.stringify({ commit: "a".repeat(40), reruns: null }),
    ]) {
      await writeFile(file, content);
      assert.deepEqual(await ciRerunNotices(folder), []);
    }
    await writeFile(
      file,
      JSON.stringify({
        commit: "a".repeat(40),
        reruns: [
          null,
          { run: 88 },
          { run: "wrong" },
          { run: "88", requestedAt: "wrong" },
          { run: "88", requestedAt: 2 },
          { run: "89", requestedAt: 1 },
        ],
      }),
    );
    assert.deepEqual(
      (await ciRerunNotices(folder)).map((notice) => notice.run),
      ["89", "88"],
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  assert.deepEqual(await ciRerunNotices(folder), []);
});

await test("CLV-198 the watch run details display the rerun", () => {
  const run = sampleRun({
    ciReruns: [{ commit: "a".repeat(40), run: "88", requestedAt: Date.now() }],
  });
  const html = rendered(
    component(Page, {
      model: sampleModel([run]),
      now: at("21:34:41"),
      copying: noCopy,
      selected: run.runId,
      stale: false,
    }),
  );
  assert.match(html, /CI rerun after a failed check.*88/);
});

await test("CLV-198 status and watch show a recorded CI rerun without exposing failure logs", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const { runId } = await waitingGate(harness, {
      service,
      commandId: "ci-visibility",
      kind: "approval",
    });
    const folder = join(
      dirname(harness.runtimeDirectory),
      "github",
      "merge-operation",
    );
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "started.json"),
      JSON.stringify({ method: "merge", runId }),
    );
    const rerun = {
      run: "88",
      requestedAt: Date.now(),
      checks: [101],
      output: "private failure output",
    };
    await writeFile(
      join(folder, `ci-${"a".repeat(32)}.json`),
      JSON.stringify({
        commit: "b".repeat(40),
        startedAt: Date.now(),
        reruns: [rerun],
      }),
    );
    const shown = await harness.cli(["status", runId]);
    assert.equal(shown.status, 0);
    assert.match(shown.stdout, /CI rerun after a failed check.*88/);
    const overview = await harness.cli(["status"]);
    assert.match(overview.stdout, /CI rerun after a failed check.*88/);
    const json = parsed(await harness.cli(["status", runId, "--json"]));
    const notices = field(field(json, "run"), "ciReruns");
    assert.deepEqual(notices, [
      { run: "88", requestedAt: rerun.requestedAt, commit: "b".repeat(40) },
    ]);
    const model = await watchedModel(harness.runtimeDirectory);
    const runs = field(model, "runs");
    assert.ok(Array.isArray(runs));
    assert.deepEqual(field(runs[0], "ciReruns"), notices);
    assert.doesNotMatch(JSON.stringify(model), /private failure output/);
    await service.close();
  }));
