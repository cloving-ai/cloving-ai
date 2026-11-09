import assert from "node:assert/strict";
import { after, test } from "node:test";
import { commandGateway } from "../src/service/gateway.ts";
import type { Fields, Reply } from "../src/protocol.ts";
import type { ServiceContext } from "../src/service/replies.ts";
import { steerRun } from "../src/service/steer-handler.ts";
import {
  executeStored,
  opened,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import { field } from "./service-fixture.ts";
import { statusContext } from "./service-views.ts";
import { servicePrelude, withConsumer } from "./world-host-fixture.ts";

const workflows = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

export async function develop(input: { cycleId: string }) {
  "use workflow";
  await protectedEffect({ scope: { phase: "implement", operation: "claude-turn", round: 1 }, capability: "fake-harness", method: "run-turn", target: "workspace/main", payload: "turn " + input.cycleId, units: 1 });
  return { kind: "handoff_requested", cycleId: input.cycleId };
}
`;

const scene = `${servicePrelude}
const steered = [];
const answers = existsSync("answer.json") ? JSON.parse(readFileSync("answer.json", "utf8")) : [];
const turnSteering = { steer: async (request) => { steered.push(request); return answers.shift() ?? { delivery: "now", operationId: "operation-of-" + request.runId }; } };
const refusal = (reply) => [reply.kind, reply.error?.code ?? reply.code];
const finalState = async (runId) => { await until(async () => ["completed", "failed", "cancelled"].includes(await stateOf(runId))); return await stateOf(runId); };
const answer = ({ kind, delivery, reason, operationId, replayed, noteId }) => ({ kind, delivery, reason, operationId: operationId === undefined ? undefined : operationId.startsWith("operation-of-run-"), replayed, noteId: /^note-[0-9a-f]{32}$/.test(noteId) });
writeFileSync("hold-effect", "");
const service = await hosted({ turnSteering });
const runId = await submitted("c-1");
await until(() => lines("destination.log").length === 1);
`;

await test("CLV-327 a steer note without now records run.noted with the source steer, answers queued, and does not reach the turn in work", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${scene}
const reply = await asked("steer-run", { runId, commandId: "s-1", note: "  Change only src/cli.ts.  " });
const events = (await asked("events", { after: 0, limit: 1000, runId })).events;
const noted = events.filter((event) => event.type === "run.noted");
const { run } = await asked("status", { runId });
print({
  reply: answer(reply),
  payload: { ...noted[0]?.payload, noteId: noted[0]?.payload.noteId === reply.noteId },
  notes: run.notes?.map(({ recordedAt, noteId, ...note }) => note),
  steered,
  sends: lines("destination.log").length,
});
rmSync("hold-effect");
await finalState(runId);
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [
      {
        reply: {
          kind: "run-noted",
          delivery: "queued",
          replayed: false,
          noteId: true,
        },
        payload: {
          noteId: true,
          note: "Change only src/cli.ts.",
          source: "steer",
        },
        notes: [
          {
            text: "Change only src/cli.ts.",
            source: "steer",
            receivedBy: null,
          },
        ],
        steered: [],
        sends: 1,
      },
    ]);
  }));

await test("CLV-327 a steer note with now asks the worker to give the note to the turn in work and answers its delivery", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`
import { writeFileSync as writeAnswers } from "node:fs";
writeAnswers("answer.json", JSON.stringify([undefined, { delivery: "queued", reason: "no-session" }]));
${scene}
const now = await asked("steer-run", { runId, commandId: "s-1", note: "Change only src/cli.ts.", now: true });
const sessionless = await asked("steer-run", { runId, commandId: "s-2", note: "Keep the tests.", now: true });
print({
  now: answer(now),
  sessionless: answer(sessionless),
  steered: steered.map((request) => ({ ...request, runId: request.runId === runId, noteId: [now.noteId, sessionless.noteId].includes(request.noteId) })),
});
rmSync("hold-effect");
await finalState(runId);
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [
      {
        now: {
          kind: "run-noted",
          delivery: "now",
          operationId: true,
          replayed: false,
          noteId: true,
        },
        sessionless: {
          kind: "run-noted",
          delivery: "queued",
          reason: "no-session",
          replayed: false,
          noteId: true,
        },
        steered: [
          { runId: true, text: "Change only src/cli.ts.", noteId: true },
          { runId: true, text: "Keep the tests.", noteId: true },
        ],
      },
    ]);
  }));

await test("CLV-327 the service refuses a note for an ended, dropped or unknown run, a blank or long note, and a repeated command ID with another note", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${scene}
const blank = await asked("steer-run", { runId, commandId: "s-blank", note: " \\n\\t " });
const long = await asked("steer-run", { runId, commandId: "s-long", note: "x".repeat(4001) });
const first = await asked("steer-run", { runId, commandId: "s-1", note: "  " + "y".repeat(4000) + "  " });
const again = await asked("steer-run", { runId, commandId: "s-1", note: "y".repeat(4000), now: true });
const other = await asked("steer-run", { runId, commandId: "s-1", note: "Another note." });
const unknown = await asked("steer-run", { runId: "run-unknown", commandId: "s-unknown", note: "A note." });
rmSync("hold-effect");
await finalState(runId);
const ended = await asked("steer-run", { runId, commandId: "s-ended", note: "A note." });
writeFileSync("hold-effect", "");
const dropped = await submitted("c-2");
await until(() => lines("destination.log").length === 2);
await asked("run-command", { command: "drop", runId: dropped, expectedRevision: (await asked("status", { runId: dropped })).run.revision, commandId: "drop" });
await finalState(dropped);
const droppedReply = await asked("steer-run", { runId: dropped, commandId: "s-dropped", note: "A note." });
const replayedAfterEnd = await asked("steer-run", { runId, commandId: "s-1", note: "y".repeat(4000) });
rmSync("hold-effect");
print({
  blank: refusal(blank),
  long: refusal(long),
  first: [first.kind, first.replayed],
  again: [again.kind, again.replayed, again.noteId === first.noteId, again.delivery],
  other: refusal(other),
  unknown: refusal(unknown),
  ended: refusal(ended),
  cancelled: refusal(droppedReply),
  replayedAfterEnd: [replayedAfterEnd.kind, replayedAfterEnd.replayed],
  notes: (await asked("events", { after: 0, limit: 1000, runId })).events.filter((event) => event.type === "run.noted").length,
  steered: steered.length,
});
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [
      {
        blank: ["error", "invalid-note"],
        long: ["error", "invalid-note"],
        first: ["run-noted", false],
        again: ["run-noted", true, true, null],
        other: ["error", "conflicting-command"],
        unknown: ["error", "unknown-run"],
        ended: ["error", "run-not-active"],
        cancelled: ["error", "run-cancelled"],
        replayedAfterEnd: ["run-noted", true],
        notes: 1,
        steered: 0,
      },
    ]);
  }));

await test("CLV-327 a steer note with now waits for the next turn when the service has no turn steering, and a request with a now that is not true or false is not valid", () =>
  withConsumer(workflows, async (consumer) => {
    const result = await consumer.run(`${servicePrelude}
writeFileSync("hold-effect", "");
const service = await hosted();
const runId = await submitted("c-1");
await until(() => lines("destination.log").length === 1);
const queuedReply = await asked("steer-run", { runId, commandId: "s-1", note: "A note.", now: true });
const invalid = await asked("steer-run", { runId, commandId: "s-2", note: "A note.", now: "yes" });
rmSync("hold-effect");
print({ queued: [queuedReply.delivery, queuedReply.reason], invalid: invalid.error?.code ?? invalid.code });
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, [
      { queued: ["queued", "no-open-turn"], invalid: "invalid-request" },
    ]);
  }));

after(removeTemporaryDirectories);

function racedContext(context: ServiceContext, request: Fields) {
  const answers: Reply[] = [];
  const { authority } = context;
  const queries = {
    ...authority.queries,
    run: async (runId: string) => {
      if (answers.length === 0) answers.push(await steerRun(context, request));
      return authority.queries.run(runId);
    },
  };
  return {
    answers,
    context: { ...context, authority: { ...authority, queries } },
  };
}

await test("CLV-327 a request that finds its note recorded by an equal request after its replay check answers replayed and does not give the note to the turn again", async () => {
  const { store } = await opened(await temporaryDirectory());
  try {
    for (const command of storedGate.slice(0, 2))
      await executeStored(store, command);
    const steered: unknown[] = [];
    const base = statusContext(store);
    const context: ServiceContext = {
      ...base,
      gateway: commandGateway({ ...base, authority: store }),
      turnSteering: {
        steer: (note) => {
          steered.push(note);
          return Promise.resolve({
            delivery: "now",
            operationId: "operation-1",
          });
        },
      },
    };
    const request = {
      runId: "run-1",
      commandId: "s-1",
      note: "Change only src/cli.ts.",
      now: true,
    };
    const raced = racedContext(context, request);
    const later = field(await steerRun(raced.context, request), "result");
    const earlier = field(raced.answers[0], "result");
    assert.deepEqual(
      [earlier, later].map((answer) => [
        field(answer, "kind"),
        field(answer, "replayed"),
        field(answer, "delivery") ?? null,
      ]),
      [
        ["run-noted", false, "now"],
        ["run-noted", true, null],
      ],
    );
    assert.equal(field(later, "noteId"), field(earlier, "noteId"));
    assert.equal(steered.length, 1);
  } finally {
    await store.close();
  }
});
