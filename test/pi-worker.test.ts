import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startTurn, succeeded } from "../src/daemon/claude-turn.ts";
import {
  intent,
  field,
  record,
  journalKey,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import { fakePi, piEvents, piMessage, piReport } from "./pi-fixture.ts";

await test("CLV-364 native Pi runs its RPC command in the turn worktree", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      harness: { name: "pi", path: fakePi(scene) },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const report = resultOf(scene.reports[0].result);
    assert.equal(report["harness"], "pi");
    assert.equal(report["summary"], piReport);
    const observed = resultOf(
      readFileSync(join(scene.directory, "observed.json"), "utf8"),
    );
    assert.deepEqual(observed["arguments"], [
      "--mode",
      "rpc",
      "--session",
      String(
        field(
          field(record(scene, "operation-1/started.json"), "piSession"),
          "path",
        ),
      ),
    ]);
    assert.equal(observed["directory"], report["worktree"]);
    assert.equal(observed["stdin"], "");
  }));

await test("CLV-364 Pi cannot complete on agent_end before more work and settlement", () =>
  withScene(async (scene) => {
    const gate = join(scene.directory, "release");
    const command = fakePi(scene, { events: piEvents().slice(0, -1), gate });
    const running = startTurn({
      worker: "pi",
      command: [command],
      directory: scene.repository,
      folder: scene.directory,
      prompt: "literal",
    });
    let completed = false;
    const completion = running.ended.then((end) => {
      completed = true;
      return end;
    });
    try {
      const activity = join(scene.directory, "turn.jsonl");
      await until(() => existsSync(activity));
      await until(() => readFileSync(activity, "utf8").includes("Implemented"));
      assert.equal(completed, false);
      writeFileSync(gate, "release");
      const end = await completion;
      assert.equal(succeeded(end), false);
      assert.match(end.result?.text ?? "", /settle/i);
    } finally {
      running.stop(10);
      await completion;
    }
  }));

await test("CLV-364 Pi waits for process exit after settlement and rejects a nonzero exit", () =>
  withScene(async (scene) => {
    const gate = join(scene.directory, "release");
    const command = fakePi(scene, { gate, exitCode: 7 });
    const running = startTurn({
      worker: "pi",
      command: [command],
      directory: scene.repository,
      folder: scene.directory,
      prompt: "literal",
    });
    let completed = false;
    const completion = running.ended.then((end) => {
      completed = true;
      return end;
    });
    try {
      const activity = join(scene.directory, "turn.jsonl");
      await until(() => existsSync(activity));
      await until(() => readFileSync(activity, "utf8").includes("Implemented"));
      assert.equal(completed, false);
      writeFileSync(gate, "release");
      assert.equal(succeeded(await completion), false);
    } finally {
      running.stop(10);
      await completion;
    }
  }));

await test("CLV-364 Pi rejects aborted settlement and a failed final assistant", async () => {
  for (const events of [
    [...piEvents().slice(0, -1), { type: "agent_settled", aborted: true }],
    piEvents(
      piMessage({ stopReason: "error", errorMessage: "Provider failed" }),
    ),
  ])
    await withScene(async (scene) => {
      const command = fakePi(scene, { events });
      const end = await startTurn({
        worker: "pi",
        command: [command],
        directory: scene.repository,
        folder: scene.directory,
        prompt: "literal",
      }).ended;
      assert.equal(succeeded(end), false);
      assert.match(end.result?.text ?? "", /abort|Provider failed/i);
    });
});

await test("CLV-364 Pi retains usage provenance and estimates only complete primary usage", () =>
  withScene(async (scene) => {
    const worker = scene.worker("unused", {
      harness: { name: "pi", path: fakePi(scene) },
      tokenPrices: {
        "test-provider/test-model": { input: 2, cachedInput: 0.5, output: 8 },
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const report = resultOf(scene.reports[0]?.result);
    assert.deepEqual(report["usage"], {
      input_tokens: 100,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
      output_tokens: 20,
    });
    assert.equal(report["costUsd"], null);
    assert.ok(Math.abs(Number(report["estimatedCostUsd"]) - 0.00038) < 1e-12);
    const accounting = resultOf(JSON.stringify(report["piAccounting"]));
    assert.equal(accounting["scope"], "primary-model");
    assert.equal(accounting["auxiliaryWork"], false);
  }));

await test("CLV-364 Pi never estimates missing cache writes, cache writes or nested work", async () => {
  for (const usage of [
    undefined,
    { input: 100, output: 20, cacheRead: 40 },
    { input: 100, output: 20, cacheRead: 40, cacheWrite: 50 },
  ]) {
    await withScene(async (scene) => {
      const worker = scene.worker("unused", {
        harness: {
          name: "pi",
          path: fakePi(scene, { events: piEvents(piMessage({ usage })) }),
        },
        tokenPrices: {
          "test-provider/test-model": { input: 2, cachedInput: 0.5, output: 8 },
        },
      });
      await worker.deliver(intent(), new AbortController().signal);
      await until(() => scene.reports.length === 1);
      assert.equal(
        resultOf(scene.reports[0]?.result)["estimatedCostUsd"],
        null,
      );
    });
  }
});

await test("CLV-364 a Pi profile uses its private command, model and allowed environment", () =>
  withScene(async (scene) => {
    const command = fakePi(scene);
    const worker = scene.worker("unused", {
      worker: "claude",
      workerCommands: { pi: [command, "--mode", "json", "--thinking", "high"] },
      profiles: {
        native: {
          harness: "pi",
          model: "operator/model",
          env: {
            TURN_VALUE: "allowed",
            GH_TOKEN: "removed",
            GITHUB_TOKEN: "removed",
            GH_ENTERPRISE_TOKEN: "removed",
            GITHUB_ENTERPRISE_TOKEN: "removed",
            GH_CONFIG_DIR: "replaced",
          },
        },
      },
    });
    await worker.deliver(
      intent({ method: "run-turn:native" }),
      new AbortController().signal,
    );
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(resultOf(scene.reports[0].result)["harness"], "pi");
    const observed = resultOf(
      readFileSync(join(scene.directory, "observed.json"), "utf8"),
    );
    assert.deepEqual(observed["arguments"], [
      "--mode",
      "rpc",
      "--thinking",
      "high",
      "--model",
      "operator/model",
      "--session",
      String(
        field(
          field(record(scene, "operation-1/started.json"), "piSession"),
          "path",
        ),
      ),
    ]);
    const environment = resultOf(JSON.stringify(observed["environment"]));
    assert.equal(environment["TURN_VALUE"], "allowed");
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ])
      assert.equal(environment[key], undefined);
    assert.notEqual(environment["GH_CONFIG_DIR"], "replaced");
    assert.deepEqual(observed["configuration"], []);
  }));

await test("CLV-364 long Pi turns keep response history in the journal and a bounded successful report", () =>
  withScene(async (scene) => {
    const messages = Array.from({ length: 300 }, (_, index) =>
      piMessage({ responseId: `response-${String(index)}` }),
    );
    const events = [
      ...piEvents().slice(0, 2),
      ...messages.map((message) => ({ type: "message_end", message })),
      { type: "agent_end", messages, willRetry: false },
      { type: "agent_settled", aborted: false },
    ];
    const worker = scene.worker("unused", {
      harness: { name: "pi", path: fakePi(scene, { events }) },
      tokenPrices: {
        "test-provider/test-model": { input: 2, cachedInput: 0.5, output: 8 },
      },
    });
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const report = scene.reports[0];
    assert.equal(report?.outcome, "completed");
    assert.ok(Buffer.byteLength(String(report.result)) <= 48_000);
    const result = resultOf(report.result);
    assert.equal(result["harness"], "pi");
    assert.equal(result["summary"], piReport);
    assert.deepEqual(result["ticketStatus"], { kind: "complete" });
    assert.equal(result["model"], "test-provider/test-model");
    assert.equal(result["costUsd"], null);
    assert.ok(Math.abs(Number(result["estimatedCostUsd"]) - 0.114) < 1e-12);
    assert.equal(
      resultOf(JSON.stringify(result["usage"]))["input_tokens"],
      30_000,
    );
    const accounting = resultOf(JSON.stringify(result["piAccounting"]));
    assert.equal(accounting["scope"], "primary-model");
    assert.equal(accounting["responseCount"], 300);
    assert.equal(accounting["responses"], undefined);
    assert.equal(accounting["auxiliaryWork"], false);
    assert.equal(accounting["nestedUsage"], null);
    const journal = readFileSync(
      join(scene.journal, journalKey("operation-1"), "turn.jsonl"),
      "utf8",
    );
    const terminal = resultOf(journal.trimEnd().split("\n").at(-1));
    const history = resultOf(JSON.stringify(terminal["piAccounting"]))[
      "responses"
    ];
    assert.ok(Array.isArray(history));
    assert.equal(history.length, 300);
    assert.equal(
      resultOf(JSON.stringify(history[299]))["responseId"],
      "response-299",
    );
  }));
