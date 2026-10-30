import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  field,
  git,
  intent,
  journalKey,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const key = journalKey("operation-1");
const accepted = { receipt: key, worker: "claude" };

function identity(operationId: string): typeof accepted {
  return { receipt: journalKey(operationId), worker: "claude" };
}

await test("CLV-013 the Claude worker starts one turn in a new work tree on a new branch, gives the payload text on standard input, and replies at once with a receipt and the worker name", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold");
    assert.deepEqual(await worker.deliver(intent(), signal), accepted);
    await until(() => scene.turns().length === 1);
    const tree = join(scene.worktrees, "ticket-one");
    const [turn] = scene.turns();
    assert.deepEqual(
      [turn?.prompt, turn?.directory],
      ["prompt of sha256:prompt", tree],
    );
    assert.equal(
      git(tree, ["rev-parse", "--abbrev-ref", "HEAD"]),
      "cloving/ticket-one",
    );
    const started = record(scene, "operation-1/started.json");
    assert.deepEqual(
      ["operationId", "target", "branch", "worktree", "processId"].map((name) =>
        field(started, name),
      ),
      [
        "operation-1",
        "ticket/one",
        "cloving/ticket-one",
        tree,
        turn?.processId,
      ],
    );
    assert.deepEqual(
      [field(started, "startCommit"), typeof field(started, "startedAt")],
      [git(scene.repository, ["rev-parse", "HEAD"]), "string"],
    );
    assert.deepEqual(scene.reports, []);
  }));

await test("CLV-013 when a turn ends, the worker records a result with the commit, the changed file and the cost, sends one report with the fields of the intent, and reconcile gives the result also in a new worker", () =>
  withScene(async (scene) => {
    const worker = scene.worker("complete");
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    const [report] = scene.reports;
    assert.deepEqual(
      { ...report, result: "" },
      {
        runId: "run-1",
        commandId: `claude-turn:${key}`,
        operationId: "operation-1",
        inputDigest: intent().inputDigest,
        leaseGeneration: 1,
        worker: "claude",
        outcome: "completed",
        result: "",
      },
    );
    const result = resultOf(report?.result);
    assert.deepEqual(result["usage"], {
      input_tokens: 1500,
      cache_read_input_tokens: 800,
      output_tokens: 150,
    });
    assert.deepEqual(
      ["summary", "branch", "worktree", "uncommitted", "costUsd"].map(
        (name) => result[name],
      ),
      [
        "Done: prompt of sha256:prompt",
        "cloving/ticket-one",
        join(scene.worktrees, "ticket-one"),
        ["?? loose.txt"],
        0.25,
      ],
    );
    assert.deepEqual([result["sessionId"], result["turns"]], ["session-1", 3]);
    assert.match(
      JSON.stringify([result["commits"], result["files"]]),
      /^\[\["[0-9a-f]{7,} Add the change 1"\],\[" change-1\.txt \| 1 \+"," 1 file changed, 1 insertion\(\+\)"\]\]$/,
    );
    const completed = {
      kind: "completed",
      ...accepted,
      result: report?.result,
    };
    assert.deepEqual(await worker.reconcile(intent(), signal), completed);
    const later = scene.worker("hold");
    assert.deepEqual(await later.reconcile(intent(), signal), completed);
    assert.deepEqual(
      field(record(scene, "operation-1/result.json"), "outcome"),
      "completed",
    );
  }));

await test("CLV-013 a second deliver of one operation starts no second process: it gives the recorded outcome after the result, and the acceptance while the turn is in work", () =>
  withScene(async (scene) => {
    const worker = scene.worker("complete");
    await worker.deliver(intent(), signal);
    await until(() => scene.reports.length === 1);
    assert.deepEqual(await worker.deliver(intent(), signal), {
      kind: "completed",
      ...accepted,
      result: scene.reports[0]?.result,
    });
    const held = scene.worker("hold");
    const second = intent({ operationId: "operation-2", target: "ticket/two" });
    await held.deliver(second, signal);
    await until(() => scene.turns().length === 2);
    assert.deepEqual(await held.deliver(second, signal), {
      kind: "accepted",
      ...identity("operation-2"),
    });
    await delay(50);
    assert.equal(scene.turns().length, 2);
  }));

await test("CLV-013 a turn that ends with an exit code, with an error result, with no result line or with a command that does not start gets the outcome failed with the reason claude-turn-failed, and a failed turn with a result line keeps its cost in the result", () =>
  withScene(async (scene) => {
    const absent = join(scene.directory, "no-such-command");
    const commands = ["exit-code", "error-result", "no-result", absent];
    for (const [index, mode] of commands.entries()) {
      const operationId = `operation-${String(index)}`;
      const failing = intent({ operationId, target: `ticket/${operationId}` });
      const worker = scene.worker(
        mode,
        mode === absent ? { command: [absent] } : {},
      );
      await worker.deliver(failing, signal);
      await until(() => scene.reports.length === index + 1);
      const report = scene.reports[index];
      assert.deepEqual(
        [report?.operationId, report?.outcome, report?.reason],
        [operationId, "failed", "claude-turn-failed"],
      );
      const result =
        report?.result === undefined ? {} : { result: report.result };
      assert.deepEqual(await worker.reconcile(failing, signal), {
        kind: "failed",
        ...identity(operationId),
        reason: "claude-turn-failed",
        ...result,
      });
    }
    for (const report of scene.reports.slice(0, 2))
      assert.deepEqual(resultOf(report.result)["usage"], {
        input_tokens: 1500,
        cache_read_input_tokens: 800,
        output_tokens: 150,
      });
    assert.deepEqual(
      scene.reports.map((report) =>
        report.result === undefined
          ? undefined
          : resultOf(report.result)["costUsd"],
      ),
      [0.25, 0.25, undefined, undefined],
    );
  }));

await test("CLV-013 an absent payload, a capability or a method that the worker does not have, and a repository with no git data give a failed reply, start no process and leave no record", () =>
  withScene(async (scene) => {
    const worker = scene.worker("complete", {
      document: () => Promise.resolve(undefined),
    });
    assert.deepEqual(await worker.deliver(intent(), signal), {
      kind: "failed",
      reason: "payload-not-available",
    });
    const start = {
      kind: "start-run" as const,
      runId: "run-1",
      operationId: "operation-1",
      workflow: "sha256:pin",
      inputDigest: intent().inputDigest,
      purpose: "dispatch" as const,
    };
    for (const other of [
      intent({ capability: "fake-harness" }),
      intent({ method: "review" }),
      start,
    ])
      assert.deepEqual(await scene.worker("complete").deliver(other, signal), {
        kind: "failed",
        reason: "unsupported-effect",
      });
    const outside = scene.worker("complete", { repository: scene.directory });
    assert.deepEqual(await outside.deliver(intent(), signal), {
      kind: "failed",
      reason: "work-tree-not-available",
    });
    await delay(50);
    assert.deepEqual(
      [scene.turns(), scene.reports, existsSync(scene.journal)],
      [[], [], false],
    );
    assert.deepEqual(await worker.reconcile(intent(), signal), {
      kind: "absent",
    });
  }));

await test("CLV-013 reconcile gives absent for an operation with no record, accepted for a turn in work, unknown for a non-Claude turn of a different process that is alive, and failed for an interrupted turn whose recorded process is not alive", () =>
  withScene(async (scene) => {
    const worker = scene.worker("hold", { worker: "codex" });
    assert.deepEqual(await worker.reconcile(intent(), signal), {
      kind: "absent",
    });
    await worker.deliver(intent(), signal);
    assert.deepEqual(await worker.reconcile(intent(), signal), {
      kind: "accepted",
      ...accepted,
    });
    const later = scene.worker("hold", { worker: "codex" });
    assert.deepEqual(await later.reconcile(intent(), signal), {
      kind: "unknown",
      evidence: `claude-turn:${key}`,
    });
    const ended = spawnSync(process.execPath, ["-e", ""]).pid;
    for (const [operationId, processId] of [
      ["operation-dead", ended],
      ["operation-unstarted", null],
    ] as const) {
      const folder = join(scene.journal, journalKey(operationId));
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "started.json"),
        JSON.stringify({ operationId, processId }),
      );
      const interrupted = {
        kind: "failed",
        ...identity(operationId),
        reason: "claude-turn-interrupted",
      };
      const lost = intent({ operationId });
      assert.deepEqual(await later.reconcile(lost, signal), interrupted);
      assert.deepEqual(
        field(record(scene, `${operationId}/result.json`), "reason"),
        "claude-turn-interrupted",
      );
      assert.deepEqual(await later.deliver(lost, signal), interrupted);
    }
    await until(() => scene.turns().length === 1);
    await delay(50);
    assert.equal(scene.turns().length, 1);
  }));

await test("CLV-013 a second operation on the same target continues in the same work tree and on the same branch, its result has the commits and the files since the first turn on the target, and a removed work tree is made again from its branch", () =>
  withScene(async (scene) => {
    const worker = scene.worker("complete");
    const tree = join(scene.worktrees, "ticket-one");
    for (const [index, operationId] of [
      "operation-1",
      "operation-2",
    ].entries()) {
      await worker.deliver(intent({ operationId }), signal);
      await until(() => scene.reports.length === index + 1);
    }
    const second = resultOf(scene.reports[1]?.result);
    assert.match(
      JSON.stringify([second["branch"], second["commits"]]),
      /^\["cloving\/ticket-one",\["[0-9a-f]{7,} Add the change 2","[0-9a-f]{7,} Add the change 1"\]\]$/,
    );
    assert.match(
      JSON.stringify(second["files"]),
      /^\[" change-1\.txt \| 1 \+"," change-2\.txt \| 1 \+"," loose\.txt +\| 1 \+"," 3 files changed, 3 insertions\(\+\)"\]$/,
    );
    rmSync(tree, { recursive: true, force: true });
    await worker.deliver(intent({ operationId: "operation-3" }), signal);
    await until(() => scene.reports.length === 3);
    assert.equal(
      String(resultOf(scene.reports[2]?.result)["commits"]).split(",").length,
      3,
    );
    assert.deepEqual(
      scene.turns().map((turn) => turn.directory),
      [tree, tree, tree],
    );
    assert.deepEqual(
      ["change-1.txt", "change-2.txt", "change-3.txt"].map((name) =>
        existsSync(join(tree, name)),
      ),
      [true, true, true],
    );
    assert.equal(
      git(scene.repository, ["rev-list", "--count", "cloving/ticket-one"]),
      "4",
    );
  }));

await test("CLV-013 a report that the authority does not take does not stop the worker, and reconcile gives the recorded result", () =>
  withScene(async (scene) => {
    const outcomes: string[] = [];
    const worker = scene.worker("complete", {
      report: (report) => {
        outcomes.push(report.outcome);
        return Promise.reject(new Error("the authority is closed"));
      },
    });
    await worker.deliver(intent(), signal);
    await until(() => outcomes.length === 1);
    await worker.close();
    assert.equal(
      field(await worker.reconcile(intent(), signal), "kind"),
      "completed",
    );
  }));

await test("CLV-013 a target with path characters gives a work tree inside the work tree folder, a long result text is cut to the limits, and a result line with no values gives empty and null fields", () =>
  withScene(async (scene) => {
    const results: Readonly<Record<string, unknown>>[] = [];
    for (const [index, mode] of ["long", "wide", "bare"].entries()) {
      const operationId = `operation-${mode}`;
      const target = "../outside/.hidden.";
      await scene.worker(mode).deliver(intent({ operationId, target }), signal);
      await until(() => scene.reports.length === index + 1);
      results.push(resultOf(scene.reports[index]?.result));
    }
    const [long, wide, bare] = results;
    assert.deepEqual(
      [long?.["worktree"], long?.["branch"], String(long?.["summary"]).length],
      [
        join(scene.worktrees, "--outside-.hidden-"),
        "cloving/--outside-.hidden-",
        16_000,
      ],
    );
    const cut = String(wide?.["summary"]).length;
    assert.deepEqual(
      [
        cut > 15_000 && cut < 16_000,
        Buffer.byteLength(String(scene.reports[1]?.result)) <= 48_000,
      ],
      [true, true],
    );
    assert.deepEqual(
      ["summary", "costUsd", "sessionId", "turns"].map((name) => bare?.[name]),
      ["", null, "session-3", null],
    );
  }));

await test("CLV-202 retained analysis turns are unsupported even with a matching profile", () =>
  withScene(async (scene) => {
    for (const profiles of [
      {},
      { "analyze-chats": { allowedTools: ["Bash"] } },
    ]) {
      const worker = scene.worker("hold", {
        profiles,
        workflowId: () => Promise.resolve("analyze-chats"),
      });
      const retired = intent({ method: "run-turn:analyze-chats" });
      for (const deliver of [worker.deliver, worker.reconcile, worker.stop])
        assert.deepEqual(await deliver(retired, signal), {
          kind: "failed",
          reason: "unsupported-effect",
        });
    }
    assert.deepEqual(scene.turns(), []);
    assert.deepEqual(scene.reports, []);
  }));
