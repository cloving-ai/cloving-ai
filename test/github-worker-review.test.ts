import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { journalKey, resultOf } from "./claude-worker-fixture.ts";
import {
  committed,
  githubIntent,
  opened,
  pullBody as body,
  pullTitle as title,
  treeOf as tree,
  withGithub,
  type GithubScene,
} from "./github-worker-fixture.ts";

const signal = new AbortController().signal;

await test("CLV-063 the GitHub worker waits for the Greptile review of the pushed commit and gives its score, its summary and its findings for that commit only", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [3, 5] });
    const worker = scene.worker();
    const first = await opened(scene, worker);
    const call = (commit: string): Parameters<GithubScene["perform"]>[1] => ({
      method: "wait-review",
      payload: { number: 1, commit },
    });
    const review = resultOf((await scene.perform(worker, call(first))).result);
    assert.deepEqual(
      [review["number"], review["commit"], review["score"], review["findings"]],
      [
        1,
        first,
        3,
        [
          {
            path: "src/change.ts",
            line: 3,
            body: "Finding of the review with the score 3.",
          },
        ],
      ],
    );
    assert.match(String(review["summary"]), /Confidence Score: 3\/5/);
    assert.doesNotMatch(String(review["summary"]), /<!--/);
    const fixed = committed(tree(scene), { name: "one.ts", text: "one;\n" });
    await scene.perform(worker, {
      method: "open-pr",
      payload: { title, body },
    });
    const second = resultOf((await scene.perform(worker, call(fixed))).result);
    assert.deepEqual(
      [second["commit"], second["score"], second["findings"]],
      [fixed, 5, []],
    );
    assert.deepEqual(scene.state().triggers, []);
  }));

await test("CLV-063 the GitHub worker asks Greptile for a review with one comment when no review comes in the trigger time", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [4], waitForTrigger: true });
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    const report = await scene.perform(worker, {
      method: "wait-review",
      payload: { number: 1, commit },
    });
    assert.equal(resultOf(report.result)["score"], 4);
    assert.deepEqual(scene.state().triggers, [1]);
    assert.ok(
      scene
        .state()
        .calls.some(
          (call) =>
            JSON.stringify(call) ===
            JSON.stringify(["pr", "comment", "1", "--body", "@greptileai"]),
        ),
    );
  }));

await test("CLV-063 the GitHub worker stops the wait with a failure when no review comes in the time limit", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    const report = await scene.perform(worker, {
      method: "wait-review",
      payload: { number: 1, commit },
    });
    assert.deepEqual(
      [report.outcome, report.reason],
      ["failed", "review-not-received"],
    );
    assert.deepEqual(scene.state().triggers, [1]);
  }));

await test("CLV-063 the GitHub worker keeps the wait when the trigger comment fails, and does not take the review of an earlier commit for the pushed commit", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [3], fail: "pr comment" });
    const worker = scene.worker();
    const first = await opened(scene, worker);
    const call = (commit: string): Parameters<GithubScene["perform"]>[1] => ({
      method: "wait-review",
      payload: { number: 1, commit },
    });
    const review = await scene.perform(worker, call(first));
    assert.equal(resultOf(review.result)["score"], 3);
    const fixed = committed(tree(scene), { name: "one.ts", text: "one;\n" });
    await scene.perform(worker, {
      method: "open-pr",
      payload: { title, body },
    });
    const waited = await scene.perform(worker, call(fixed));
    assert.deepEqual(
      [waited.outcome, waited.reason, scene.state().triggers],
      ["failed", "review-not-received", []],
    );
    assert.ok(
      scene
        .state()
        .calls.some(
          (item) => item.join(" ") === "pr comment 1 --body @greptileai",
        ),
    );
  }));

await test("CLV-067 the GitHub worker stops an active wait on request and reports it as stopped, and ends an active wait at close with no result file and no report", () =>
  withGithub(async (scene) => {
    const slow = { pollMilliseconds: 10, triggerMilliseconds: 60_000 };
    const timing = { ...slow, limitMilliseconds: 60_000 };
    const worker = scene.worker({ timing });
    const commit = await opened(scene, worker);
    const waiting = scene.worker({
      timing,
      document: () => Promise.resolve(JSON.stringify({ number: 1, commit })),
    });
    const given = githubIntent({
      operationId: "operation-wait",
      method: "wait-review",
    });
    await waiting.deliver(given, signal);
    const receipt = journalKey("operation-wait");
    assert.deepEqual(await waiting.reconcile(given, signal), {
      kind: "accepted",
      receipt,
      worker: "github",
    });
    assert.deepEqual(await waiting.stop(given, signal), {
      kind: "stopped",
      receipt,
      worker: "github",
    });
    const second = githubIntent({
      operationId: "operation-close",
      method: "wait-review",
    });
    await waiting.deliver(second, signal);
    await waiting.close();
    const last = scene.reports.at(-1);
    assert.deepEqual(
      [last?.operationId, last?.outcome],
      ["operation-wait", "stopped"],
    );
    assert.equal(
      existsSync(
        join(scene.journal, journalKey("operation-close"), "result.json"),
      ),
      false,
    );
  }));
