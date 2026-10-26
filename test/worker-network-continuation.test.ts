import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commandModel } from "../src/token-prices.ts";
import {
  field,
  git,
  intent,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import {
  networkCommand,
  networkContinuation,
} from "./network-worker-fixture.ts";

const signal = new AbortController().signal;

await test("CLV-229 network continuation has current-turn commits with fresh push evidence", () =>
  withScene(async (scene) => {
    const remote = join(scene.directory, "origin");
    mkdirSync(remote);
    git(remote, ["init", "--bare", "--quiet"]);
    git(scene.repository, ["remote", "add", "origin", remote]);
    const earlier = scene.worker("committed");
    await earlier.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    const oldCommit = git(scene.turns()[0]?.directory ?? "", [
      "rev-parse",
      "HEAD",
    ]);
    const log = join(scene.directory, "turns.log");
    writeFileSync(log, "");
    let commit = "";
    const worker = scene.worker("unused", {
      command: networkCommand(scene, ["network", "done"]),
      retryDelay: () => {
        const tree = scene.turns()[0]?.directory ?? "";
        commit = git(tree, ["rev-parse", "HEAD"]);
        git(tree, ["push", "origin", "HEAD"]);
        git(tree, [
          "update-ref",
          "refs/remotes/origin/cloving/ticket-one",
          oldCommit,
        ]);
        return Promise.resolve();
      },
    });
    await worker.deliver(intent({ operationId: "operation-2" }), signal);
    await until(() => scene.reports.length === 2);
    const [first, second] = scene.turns();
    assert.ok(first && second);
    assert.ok(second.prompt.startsWith(networkContinuation + "\n"));
    assert.ok(second.prompt.endsWith(first.prompt));
    assert.ok(second.prompt.includes(`${commit} pushed`));
    assert.ok(!second.prompt.includes(oldCommit));
    assert.doesNotMatch(second.prompt, /model was at capacity/);
    assert.ok(!second.arguments.includes("--resume"));
    assert.equal(
      field(record(scene, "operation-2/started.json"), "turnStartCommit"),
      oldCommit,
    );
  }));

for (const failures of [
  ["capacity", "network"],
  ["capacity", "network-overloaded"],
  ["network", "capacity"],
])
  await test(`CLV-229 mixed failures ${failures.join(" then ")} choose waits and models from the previous failure`, () =>
    withScene(async (scene) => {
      const waits: number[] = [];
      const commits: string[] = [];
      const worker = scene.worker("unused", {
        command: networkCommand(scene, [...failures, "done"]),
        fallbackModels: ["fallback"],
        retryDelay: (milliseconds) => {
          waits.push(milliseconds);
          commits.push(
            git(scene.turns()[0]?.directory ?? "", ["rev-parse", "HEAD"]),
          );
          return Promise.resolve();
        },
      });
      await worker.deliver(intent(), signal);
      await until(() => scene.reports.length === 1);
      const capacityFirst = failures[0] === "capacity";
      assert.deepEqual(
        waits,
        capacityFirst ? [60_000, 2_400_000] : [600_000, 180_000],
      );
      assert.deepEqual(
        scene
          .turns()
          .map((turn) => commandModel(["worker", ...turn.arguments])),
        ["main", "main", capacityFirst ? "main" : "fallback"],
      );
      const last = scene.turns()[2];
      assert.ok(last);
      assert.ok(last.prompt.startsWith(networkContinuation + "\n"));
      for (const commit of commits) assert.ok(last.prompt.includes(commit));
      const attempts = resultOf(scene.reports[0]?.result)["attempts"];
      assert.ok(Array.isArray(attempts));
      assert.deepEqual(
        attempts.map((attempt: unknown) => field(attempt, "retryKind")),
        [
          ...failures.map((kind) =>
            kind === "network-overloaded" ? "network" : kind,
          ),
          null,
        ],
      );
      for (const [index, kind] of [
        ...failures.map((kind) =>
          kind === "network-overloaded" ? "network" : kind,
        ),
        null,
      ].entries())
        assert.equal(
          field(
            record(scene, `operation-1/attempt-${String(index + 1)}.json`),
            "retryKind",
          ),
          kind,
        );
    }));
