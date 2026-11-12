import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startTurn, succeeded } from "../src/daemon/claude-turn.ts";
import { until, withScene } from "./claude-worker-fixture.ts";
import { fakePi, piEvents, piMessage } from "./pi-fixture.ts";
import { read } from "./turn-transcript-fixture.ts";
import { piStream } from "../src/daemon/pi-stream.ts";
import { resultOf } from "./claude-worker-fixture.ts";

interface LiveTurn {
  readonly activity: string;
  readonly finish: () => ReturnType<typeof startTurn>["ended"];
}

function withLivePi(
  options: Parameters<typeof fakePi>[1] & { readonly untilText: string },
  use: (turn: LiveTurn) => Promise<void>,
) {
  return withScene(async (scene) => {
    const gate = join(scene.directory, "release");
    const command = fakePi(scene, { ...options, gate, chunkBytes: 7 });
    const running = startTurn({
      worker: "pi",
      command: [command],
      directory: scene.repository,
      folder: scene.directory,
      prompt: "text",
    });
    const activity = join(scene.directory, "turn.jsonl");
    const release = () => {
      writeFileSync(gate, "release");
    };
    try {
      await until(
        () =>
          existsSync(activity) &&
          readFileSync(activity, "utf8").includes(options.untilText),
      );
      await use({
        activity,
        finish: () => {
          release();
          return running.ended;
        },
      });
    } finally {
      release();
      running.stop(10);
      await running.ended;
    }
  });
}

await test("CLV-364 Pi displays assistant deltas before completion and replaces the whole partial message", () => {
  const update = (
    type: string,
    block: { contentIndex: number; delta: string },
  ) => ({
    type: "message_update",
    assistantMessageEvent: { type, ...block },
  });
  const final = piMessage({
    content: [{ type: "text", text: "Final answer" }],
  });
  return withLivePi(
    {
      events: [
        ...piEvents().slice(0, 2),
        { type: "message_start", message: { role: "assistant", content: [] } },
        update("text_delta", { contentIndex: 0, delta: "Résumé 🐈\u2028" }),
        update("text_delta", { contentIndex: 0, delta: "in progress" }),
        update("thinking_delta", { contentIndex: 1, delta: "Partial thought" }),
        update("text_delta", { contentIndex: 2, delta: "Discarded block" }),
      ],
      untilText: "Discarded block",
      afterGateEvents: piEvents(final).slice(3),
    },
    async ({ activity, finish }) => {
      const partial = read(readFileSync(activity, "utf8"), { open: true });
      assert.deepEqual(
        partial.map((entry) => entry.text),
        ["Résumé 🐈\u2028in progress", "Partial thought", "Discarded block"],
      );
      const end = await finish();
      assert.equal(succeeded(end), true);
      assert.equal(end.result?.text, "Final answer");
      assert.deepEqual(
        read(readFileSync(activity, "utf8"))
          .filter((entry) => entry.kind !== "result")
          .map((entry) => entry.text),
        ["Final answer"],
      );
    },
  );
});

const tool = {
  toolCallId: "call-1",
  toolName: "bash",
  args: { command: "check" },
};
const toolContent = [{ type: "text", text: "Failed check" }];

await test("CLV-364 Pi emits live tool output and replaces it with one completed result", () =>
  withLivePi(
    {
      events: [
        ...piEvents().slice(0, 2),
        { type: "tool_execution_start", ...tool },
        ...["Partial", "Partial output"].map((text) => ({
          type: "tool_execution_update",
          ...tool,
          partialResult: { content: [{ type: "text", text }] },
        })),
      ],
      untilText: "Partial output",
      afterGateEvents: [
        {
          type: "tool_execution_end",
          ...tool,
          result: { content: toolContent },
          isError: true,
        },
        {
          type: "message_end",
          message: {
            role: "toolResult",
            ...tool,
            content: toolContent,
            isError: true,
          },
        },
        ...piEvents().slice(2),
      ],
    },
    async ({ activity, finish }) => {
      assert.deepEqual(
        read(readFileSync(activity, "utf8"), { open: true })
          .filter((entry) => entry.kind === "tool-result")
          .map((entry) => entry.text),
        ["Partial output"],
      );
      assert.equal(succeeded(await finish()), true);
      const entries = read(readFileSync(activity, "utf8"));
      assert.equal(
        entries.filter((entry) => entry.kind === "tool-call").length,
        1,
      );
      assert.deepEqual(
        entries
          .filter((entry) => entry.kind === "tool-result")
          .map((entry) => [entry.text, entry.error]),
        [["Failed check", true]],
      );
    },
  ));

await test("CLV-364 malformed Pi tool updates fail explicitly", () => {
  for (const update of [
    { toolCallId: "call-1", partialResult: { content: [] } },
    { toolCallId: "call-1", toolName: "bash", args: {}, partialResult: {} },
    {
      toolCallId: "call-1",
      toolName: "bash",
      args: {},
      partialResult: { content: [{ type: "text", text: 3 }] },
    },
  ]) {
    const stream = piStream();
    for (const event of [
      ...piEvents().slice(0, -1),
      { type: "tool_execution_update", ...update },
      { type: "agent_settled", aborted: false },
    ])
      stream.line(JSON.stringify(event));
    const result = resultOf(stream.result(0));
    assert.equal(result["is_error"], true);
    assert.match(
      String(result["result"]),
      /Pi malformed tool_execution_update record/,
    );
  }
});

await test("CLV-364 Pi tool updates immediately produce a transcript result", () => {
  const stream = piStream();
  stream.line(JSON.stringify({ type: "session", version: 3, id: "session" }));
  const output = stream.line(
    JSON.stringify({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "bash",
      args: {},
      partialResult: { content: [{ type: "text", text: "Live tool" }] },
    }),
  );
  assert.deepEqual(
    read(output.join("\n") + "\n").map((entry) => entry.text),
    ["Live tool"],
  );
});
