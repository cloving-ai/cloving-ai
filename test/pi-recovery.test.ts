import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { piStream } from "../src/daemon/pi-stream.ts";
import {
  alive,
  field,
  intent,
  record,
  resultOf,
  until,
  withScene,
} from "./claude-worker-fixture.ts";
import {
  gatedHarness,
  harnessProcesses,
  openGate,
  stopHarnessGroups,
  transcriptLines,
} from "./harness-detached-fixture.ts";
import { piEvents, piMessage, piReport } from "./pi-fixture.ts";
import { read } from "./turn-transcript-fixture.ts";

await test("CLV-365 Pi reconnects the same process once and accepts its replay without another prompt or cost", () =>
  withScene(async (scene) => {
    const events = piEvents();
    const harness = gatedHarness(scene, {
      worker: "pi",
      name: "pi-replay",
      output: {
        head: events.slice(0, -1),
        tail: [events[0], ...events.slice(2)],
      },
    });
    try {
      const first = scene.worker("unused", harness.settings);
      const signal = new AbortController().signal;
      await first.deliver(intent(), signal);
      await until(
        () =>
          transcriptLines(scene, "operation-1").length > 0 &&
          field(record(scene, "operation-1/started.json"), "launch") !==
            undefined,
      );
      const launch = field(record(scene, "operation-1/started.json"), "launch");
      const [process] = harnessProcesses(harness);
      assert.ok(process);
      await first.close({ turns: "keep" });
      assert.equal(alive(process.processId), true);
      const next = scene.worker("unused", harness.settings);
      const recoveries = await Promise.all([
        next.reconcile(intent(), signal),
        next.reconcile(intent(), signal),
      ]);
      assert.deepEqual(
        recoveries.map((reply) => reply.kind),
        ["accepted", "accepted"],
      );
      assert.deepEqual(
        field(record(scene, "operation-1/started.json"), "launch"),
        launch,
      );
      openGate(harness);
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "completed");
      const result = resultOf(scene.reports[0].result);
      assert.equal(result["summary"], piReport);
      assert.equal(result["turns"], 1);
      assert.equal(result["estimatedCostUsd"], 0.00038);
      assert.equal(harnessProcesses(harness).length, 1);
      const prompt = resultOf(readFileSync(harness.log, "utf8").trim());
      assert.equal(prompt["prompt"], "prompt of sha256:prompt");
      const output = read(transcriptLines(scene, "operation-1").join("\n"));
      assert.equal(
        output.filter((entry) => entry.kind === "assistant").length,
        1,
      );
    } finally {
      stopHarnessGroups(harness);
    }
  }));

await test("CLV-365 a conflicting Pi session cannot replace the first session identity", () => {
  const stream = piStream();
  for (const event of piEvents()) stream.line(JSON.stringify(event));
  stream.line(JSON.stringify({ type: "session", version: 3, id: "foreign" }));
  const result = resultOf(stream.result(0));
  assert.equal(result["session_id"], "pi-session");
  assert.equal(result["is_error"], true);
  assert.match(String(result["result"]), /conflicting session/);
});

await test("CLV-365 Pi replay without provider response IDs counts each completed message once", () => {
  const first = piMessage({ responseId: undefined });
  const second = piMessage({ responseId: undefined, timestamp: 2 });
  const stream = piStream();
  const events = [
    ...piEvents(first).slice(0, -1),
    ...piEvents(first).slice(2, 4),
    ...piEvents(second).slice(1),
  ];
  const lines = events.flatMap((event) => stream.line(JSON.stringify(event)));
  const result = resultOf(stream.result(0));
  assert.equal(result["is_error"], false);
  assert.equal(result["num_turns"], 2);
  assert.equal(
    read(lines.join("\n")).filter((entry) => entry.kind === "assistant").length,
    2,
  );
  assert.deepEqual(result["usage"], {
    input_tokens: 200,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 0,
    output_tokens: 40,
  });
});

await test("CLV-365 a stale Pi completion cannot replace newer settled work", () => {
  const first = piMessage();
  const second = piMessage({
    responseId: "second",
    timestamp: 2,
    content: [{ type: "text", text: "New work" }],
  });
  const stream = piStream();
  for (const event of [
    ...piEvents(first).slice(0, -1),
    ...piEvents(second).slice(1),
    { type: "message_end", message: first },
  ])
    stream.line(JSON.stringify(event));
  const result = resultOf(stream.result(0));
  assert.equal(result["is_error"], false);
  assert.equal(result["result"], "New work");
  assert.equal(result["num_turns"], 2);
});

await test("CLV-365 Pi session history before agent_start adds neither text nor invocation usage", () => {
  const stream = piStream();
  const historical = piMessage({
    responseId: "historical",
    content: [{ type: "text", text: "Old session work" }],
  });
  const current = piMessage({ usage: { input: 7 } });
  const events = [
    piEvents()[0],
    { type: "message_start", message: historical },
    { type: "message_end", message: historical },
    ...piEvents(current).slice(1),
  ];
  const lines = events.flatMap((event) => stream.line(JSON.stringify(event)));
  const result = resultOf(stream.result(0));
  assert.equal(result["is_error"], false);
  assert.equal(result["num_turns"], 1);
  assert.deepEqual(result["usage"], {
    input_tokens: 7,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
    output_tokens: null,
  });
  assert.equal(result["total_cost_usd"], null);
  assert.equal(
    lines.some((line) => line.includes("Old session work")),
    false,
  );
});

await test("CLV-365 Pi rejects session metadata conflicts and ignores subsequent foreign work", () => {
  for (const conflict of [
    { id: "foreign" },
    { cwd: "foreign-tree" },
    { timestamp: "different-start" },
  ]) {
    const stream = piStream();
    const header = {
      type: "session",
      version: 3,
      id: "pi-session",
      cwd: "owned-tree",
      timestamp: "owned-start",
    };
    const foreign = piMessage({
      responseId: "foreign-response",
      content: [{ type: "text", text: "Foreign work" }],
    });
    const events = [
      header,
      ...piEvents().slice(1),
      { ...header, ...conflict },
      ...piEvents(foreign).slice(1),
    ];
    const lines = events.flatMap((event) => stream.line(JSON.stringify(event)));
    const result = resultOf(stream.result(0));
    assert.equal(result["is_error"], true);
    assert.equal(result["session_id"], "pi-session");
    assert.equal(result["num_turns"], 1);
    assert.match(String(result["result"]), /conflicting session/);
    assert.equal(
      lines.some((line) => line.includes("Foreign work")),
      false,
    );
  }
});

await test("CLV-365 Pi validates required historical records before excluding their usage", () => {
  for (const event of [
    { type: "message_start" },
    { type: "message_end", message: { role: "assistant" } },
    { type: "message_end", message: { role: "toolResult" } },
  ]) {
    const stream = piStream();
    for (const record of [piEvents()[0], event, ...piEvents().slice(1)])
      stream.line(JSON.stringify(record));
    const result = resultOf(stream.result(0));
    assert.equal(result["is_error"], true);
    assert.match(String(result["result"]), /malformed/);
  }
});

await test("CLV-365 Pi retains different usage for responses with the same timestamp and body", () => {
  const first = piMessage({ responseId: undefined });
  const second = piMessage({
    responseId: undefined,
    usage: { ...first.usage, input: 200 },
  });
  const stream = piStream();
  for (const event of [
    ...piEvents(first).slice(0, -1),
    ...piEvents(second).slice(1),
  ])
    stream.line(JSON.stringify(event));
  const result = resultOf(stream.result(0));
  assert.equal(result["is_error"], false);
  assert.equal(result["num_turns"], 2);
  assert.equal(resultOf(JSON.stringify(result["usage"]))["input_tokens"], 300);
});

await test("CLV-365 Pi removes a replayed streamed preview when its known completion returns", () => {
  for (const responseId of [undefined, "response-1"])
    assertStreamReplay(piMessage({ responseId }));
});

function assertStreamReplay(message: ReturnType<typeof piMessage>): void {
  const stream = piStream();
  const events = [
    ...piEvents(message).slice(0, -1),
    {
      type: "message_start",
      message: { ...message, content: [], stopReason: "pending" },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: piReport,
      },
    },
    { type: "message_end", message },
    { type: "agent_settled", aborted: false },
  ];
  const lines = events.flatMap((event) => stream.line(JSON.stringify(event)));
  const result = resultOf(stream.result(0));
  assert.equal(result["is_error"], false);
  assert.equal(result["num_turns"], 1);
  assert.equal(
    read(lines.join("\n")).filter((entry) => entry.kind === "assistant").length,
    1,
  );
}

await test("CLV-365 Pi keeps an error and later success distinct without provider response IDs", () => {
  const first = piMessage({ responseId: undefined, stopReason: "error" });
  const second = piMessage({ responseId: undefined });
  const stream = piStream();
  for (const event of [
    ...piEvents(first).slice(0, -1),
    ...piEvents(second).slice(1),
  ])
    stream.line(JSON.stringify(event));
  const result = resultOf(stream.result(0));
  assert.equal(result["is_error"], false);
  assert.equal(result["num_turns"], 2);
  assert.equal(resultOf(JSON.stringify(result["usage"]))["input_tokens"], 200);
});
