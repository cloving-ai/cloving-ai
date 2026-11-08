import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  productRoot,
  servicePrelude,
  withConsumer,
} from "./world-host-fixture.ts";

const turnNotes = JSON.stringify(
  pathToFileURL(join(productRoot, "src/daemon/turn-notes.ts")).href,
);

const workflows = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

const step = (scope, payload) =>
  protectedEffect({ scope, capability: "fake-harness", method: "run-turn", target: "workspace/main", payload, units: 1 });

export async function develop(input: { cycleId: string }) {
  "use workflow";
  await step({ phase: "implement", operation: "claude-turn", round: 1 }, "turn " + input.cycleId);
  const merge = await step({ phase: "merge", operation: "merge", round: 1 }, "merge " + input.cycleId);
  if (merge.kind !== "completed") throw new Error(merge.reason ?? merge.kind);
  return { kind: "handoff_requested", cycleId: input.cycleId };
}
`;

const scene = `${servicePrelude}
const failing = {
  ...destination,
  deliver: async (intent) => {
    if (existsSync("fail-merge") && JSON.parse(intent.operationId)[4] === "merge") return { kind: "failed", reason: "git-call-failed", receipt: null, worker: null };
    return await destination.deliver(intent);
  },
};
const finalState = async (runId) => { await until(async () => ["completed", "failed"].includes(await stateOf(runId))); return await stateOf(runId); };
const refusal = (reply) => [reply.kind, reply.error?.code ?? reply.code];
writeFileSync("fail-merge", "");
const service = await hosted({ destination: failing });
const runId = await submitted("c-1");
await finalState(runId);
rmSync("fail-merge");
`;

await test("CLV-326 a continuation with a note records run.noted with the trimmed text and shows the note as waiting", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${scene}
writeFileSync("hold-effect", "");
const reply = await asked("continue-run", { runId, commandId: "c-note", from: "implement/claude-turn", note: "  Merge the branch of the first run first.  " });
const events = (await asked("events", { after: 0, limit: 1000, runId: reply.runId })).events;
const noted = events.filter((event) => event.type === "run.noted");
const created = events.find((event) => event.type === "run.created");
const { run } = await asked("status", { runId: reply.runId });
rmSync("hold-effect");
await finalState(reply.runId);
print({
  kind: reply.kind,
  order: events.slice(0, 2).map((event) => event.type),
  sameTime: noted[0]?.recordedAt === created?.recordedAt,
  payload: noted[0]?.payload,
  noteTime: run.notes?.[0]?.recordedAt === noted[0]?.recordedAt,
  notes: run.notes?.map(({ recordedAt, ...note }) => note),
});
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    const [line] = result.lines;
    const noteId = String(
      Reflect.get(Object(Reflect.get(Object(line), "payload")), "noteId"),
    );
    assert.match(noteId, /^note-[0-9a-f]{32}$/);
    assert.deepEqual(line, {
      kind: "run-continued",
      order: ["run.created", "run.noted"],
      sameTime: true,
      payload: {
        noteId,
        note: "Merge the branch of the first run first.",
        source: "continue",
      },
      noteTime: true,
      notes: [
        {
          noteId,
          text: "Merge the branch of the first run first.",
          source: "continue",
          receivedBy: null,
        },
      ],
    });
  }));

await test("CLV-326 the service refuses a blank note and a note of 4001 characters, and a repeated command ID with another note", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${scene}
const blank = await asked("continue-run", { runId, commandId: "c-blank", note: " \\n\\t " });
const long = await asked("continue-run", { runId, commandId: "c-long", note: "x".repeat(4001) });
const longest = "y".repeat(4000);
const first = await asked("continue-run", { runId, commandId: "c-note", note: "  " + longest + "  " });
const again = await asked("continue-run", { runId, commandId: "c-note", note: longest });
const other = await asked("continue-run", { runId, commandId: "c-note", note: "Another note." });
const none = await asked("continue-run", { runId, commandId: "c-note" });
print({
  blank: refusal(blank),
  long: refusal(long),
  first: first.kind,
  again: [again.kind, again.replayed, again.runId === first.runId],
  other: refusal(other),
  none: refusal(none),
});
await finalState(first.runId);
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      blank: ["error", "invalid-note"],
      long: ["error", "invalid-note"],
      first: "run-continued",
      again: ["run-continued", true, true],
      other: ["error", "conflicting-command"],
      none: ["error", "conflicting-command"],
    });
  }));

await test("CLV-326 a continuation gives the note to the first step that it sends, not to a reused step", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}
const { noteDesk } = await import(${turnNotes});
const desk = noteDesk({ journal: process.cwd() + "/journal", notes: { read: (runId) => ports.notes.read(runId), operations: async () => [] } });
const noting = {
  ...destination,
  deliver: async (intent) => {
    const step = JSON.parse(intent.operationId)[4];
    const noted = await desk.claim({ runId: intent.runId, prompt: step });
    appendFileSync("prompts.log", JSON.stringify(noted.prompt) + "\\n");
    if (existsSync("fail-merge") && step === "merge") return { kind: "failed", reason: "git-call-failed", receipt: null, worker: null };
    return await destination.deliver(intent);
  },
};
const finalState = async (runId) => { await until(async () => ["completed", "failed"].includes(await stateOf(runId))); return await stateOf(runId); };
writeFileSync("fail-merge", "");
const service = await hosted({ destination: noting });
const runId = await submitted("c-1");
await finalState(runId);
rmSync("fail-merge");
const reply = await asked("continue-run", { runId, commandId: "c-note", from: "merge/merge", note: "Merge the branch of the first run first." });
print({ after: await finalState(reply.runId), prompts: lines("prompts.log").map((line) => JSON.parse(line)) });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      after: "completed",
      prompts: [
        "claude-turn",
        "merge",
        "Notes from the operator:\n\nMerge the branch of the first run first.\n\nmerge",
      ],
    });
  }));
