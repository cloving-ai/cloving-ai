import assert from "node:assert/strict";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { record } from "../src/protocol.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  digestOf,
  eventually,
  field,
  items,
  parsed,
  withHarness,
  text,
  type Harness,
} from "./service-fixture.ts";

import { questionSource, questionSetup } from "./service-question-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";

import {
  host,
  continuations,
  openedQuestion,
  prompt,
} from "./service-answer-fixture.ts";
const question = {
  commandId: "w-open",
  expectedRevision: 2,
  gateId: "design-1",
  kind: "question",
  prompt,
  subject: digestOf(prompt),
} as const;

await test("CLV-145 recovery hosts retain complete coverage after harness cleanup", async () => {
  await withFiles({}, async (directory) => {
    const previous = process.env["NODE_V8_COVERAGE"];
    process.env["NODE_V8_COVERAGE"] = directory;
    try {
      const identifier = await withHarness(async (harness) => {
        const first = await host(harness, "hold-continuation");
        first.process.kill("SIGKILL");
        await once(first.process, "exit");
        assert.deepEqual(await readdir(directory), []);
        return (await host(harness, "deliver")).process.pid;
      });
      assert.equal(typeof identifier, "number");
      const files = (await readdir(directory)).filter((name) =>
        name.startsWith(`coverage-${String(identifier)}-`),
      );
      assert.equal(files.length, 1);
      const coverage = record(
        JSON.parse(await readFile(join(directory, String(files[0])), "utf8")),
      );
      assert.ok(Array.isArray(coverage?.["result"]));
    } finally {
      if (previous === undefined) delete process.env["NODE_V8_COVERAGE"];
      if (previous !== undefined) process.env["NODE_V8_COVERAGE"] = previous;
    }
  });
});

async function admittedRun(harness: Harness): Promise<string> {
  const admitted = await harness.cli([
    "run",
    "develop",
    "--prompt",
    "work on the parser",
    "--command-id",
    "c-run",
    "--json",
  ]);
  assert.equal(admitted.status, 0, admitted.stderr);
  return text(parsed(admitted), "runId");
}

async function answerArguments(harness: Harness): Promise<readonly string[]> {
  const listed = await harness.cli(["questions", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  const decisions = items(field(parsed(listed), "decisions"));
  assert.equal(decisions.length, 1);
  const [decision] = decisions;
  return [
    "answer",
    text(decision, "label"),
    "--text",
    "Use the table parser.",
    "--expected-revision",
    text(decision, "revision"),
    "--generation",
    text(decision, "generation"),
    "--subject-digest",
    text(decision, "subjectDigest"),
    "--command-id",
    "c-answer",
    "--json",
  ];
}

await test("CLV-008 an answer sent twice with the same command ID across a service restart returns the same receipt and leaves one continuation", () =>
  withHarness(async (harness) => {
    let service = await harness.start();
    const runId = await admittedRun(harness);
    await eventually(() => (harness.sent.length === 1 ? true : undefined));
    await service.worker.started({
      runId,
      commandId: "w-started",
      expectedRevision: 1,
    });
    await service.worker.openGate({ runId, ...question });
    await service.worker.registerWait({
      runId,
      commandId: "w-wait",
      gateId: "design-1",
    });
    const answer = await answerArguments(harness);
    const first = await harness.cli(answer);
    assert.equal(first.status, 0, first.stderr);
    await service.close();
    service = await harness.start();
    const second = await harness.cli(answer);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(field(parsed(first), "replayed"), false);
    assert.equal(field(parsed(second), "replayed"), true);
    assert.deepEqual(
      field(parsed(second), "receipt"),
      field(parsed(first), "receipt"),
    );
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    await delay(300);
    assert.deepEqual(
      harness.sent
        .filter((intent) => intent.kind === "continue-run")
        .map((intent) => [
          intent.runId,
          field(intent, "gateId"),
          field(intent, "decision"),
          field(intent, "answer"),
        ]),
      [[runId, "design-1", "answered", digestOf("Use the table parser.")]],
    );
    await service.close();
  }));

await test("CLV-008 a service killed after it commits an answer and before delivery delivers one continuation after the restart", () =>
  withHarness(async (harness) => {
    const first = await host(harness, "hold-continuation");
    const runId = await admittedRun(harness);
    await openedQuestion(first, runId);
    const answer = await answerArguments(harness);
    const committed = await harness.cli(answer);
    assert.equal(committed.status, 0, committed.stderr);
    await eventually(() =>
      first.lines.includes("holding") ? true : undefined,
    );
    assert.deepEqual(await continuations(harness), []);
    first.process.kill("SIGKILL");
    await once(first.process, "exit");
    const second = await host(harness, "deliver");
    await eventually(async () =>
      (await continuations(harness)).length === 1 ? true : undefined,
    );
    await delay(500);
    const delivered = await continuations(harness);
    assert.equal(delivered.length, 1);
    assert.deepEqual(
      [
        field(delivered[0], "runId"),
        field(delivered[0], "gateId"),
        field(delivered[0], "decision"),
      ],
      [runId, "design-1", "answered"],
    );
    const repeated = await harness.cli(answer);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(field(parsed(repeated), "replayed"), true);
    assert.deepEqual(
      field(parsed(repeated), "receipt"),
      field(parsed(committed), "receipt"),
    );
    second.process.kill("SIGTERM");
    await once(second.process, "exit");
  }));

await test("CLV-008 a dropped run whose start was in flight at a kill is reconciled after the restart and claims no terminal cancellation", () =>
  withHarness(async (harness) => {
    const first = await host(harness, "accept-start-without-reply");
    const runId = await admittedRun(harness);
    await eventually(() =>
      first.lines.includes("holding") ? true : undefined,
    );
    const drop = [
      "drop",
      runId,
      "--expected-revision",
      "1",
      "--command-id",
      "c-drop",
      "--json",
    ];
    const start = `["cloving-operation",0,"${runId}","admission","start-run",null,null]`;
    const dropped = await harness.cli(drop);
    assert.deepEqual(field(parsed(dropped), "observed"), {
      condition: "cancelling",
      unresolvedEffects: [start],
    });
    first.process.kill("SIGKILL");
    await once(first.process, "exit");
    const second = await host(harness, "deliver");
    const reason = async (): Promise<unknown> => {
      const status = await harness.cli(["status", runId, "--json"]);
      const run = field(parsed(status), "run");
      return [field(run, "condition"), field(field(run, "reason"), "code")];
    };
    await eventually(async () =>
      JSON.stringify(await reason()).includes("stop-not-observed")
        ? true
        : undefined,
    );
    assert.deepEqual(await reason(), ["cancelling", "stop-not-observed"]);
    const repeated = await harness.cli(drop);
    assert.deepEqual(
      [
        field(parsed(repeated), "replayed"),
        field(parsed(repeated), "observed"),
      ],
      [true, { condition: "cancelling", unresolvedEffects: [] }],
    );
    const lines = await readFile(
      join(harness.stateDirectory, "deliveries.jsonl"),
      "utf8",
    );
    assert.equal(lines.split("\n").filter((line) => line.length > 0).length, 1);
    second.process.kill("SIGTERM");
    await once(second.process, "exit");
  }));

await test("CLV-008 a paused run whose start was in flight at a kill is reconciled after the restart, and a later drop claims no terminal cancellation", () =>
  withHarness(async (harness) => {
    const first = await host(harness, "accept-start-without-reply");
    const runId = await admittedRun(harness);
    await eventually(() =>
      first.lines.includes("holding") ? true : undefined,
    );
    const command = async (
      name: string,
      revision: number,
    ): Promise<unknown> => {
      const result = await harness.cli([
        name,
        runId,
        "--expected-revision",
        String(revision),
        "--command-id",
        `c-${name}`,
        "--json",
      ]);
      return field(parsed(result), "observed");
    };
    const start = `["cloving-operation",0,"${runId}","admission","start-run",null,null]`;
    assert.deepEqual(await command("pause", 1), {
      condition: "paused",
      unresolvedEffects: [start],
    });
    first.process.kill("SIGKILL");
    await once(first.process, "exit");
    const second = await host(harness, "deliver");
    await eventually(async () => {
      const events = await harness.cli(["events", runId, "--json"]);
      return events.stdout.includes("step.dispatched") ? true : undefined;
    });
    assert.deepEqual(await command("drop", 2), {
      condition: "cancelling",
      unresolvedEffects: [],
    });
    const status = await harness.cli(["status", runId, "--json"]);
    const run = field(parsed(status), "run");
    assert.deepEqual(
      [field(run, "condition"), field(field(run, "reason"), "code")],
      ["cancelling", "stop-not-observed"],
    );
    const lines = await readFile(
      join(harness.stateDirectory, "deliveries.jsonl"),
      "utf8",
    );
    assert.equal(lines.split("\n").filter((line) => line.length > 0).length, 1);
    second.process.kill("SIGTERM");
    await once(second.process, "exit");
  }));

await test("CLV-148 the generic service durably records added answer text and the workflow continuation rejects it", () =>
  withConsumer(questionSource, async (consumer) => {
    const result = await consumer.run(`${questionSetup}
const response = await answer("earlier with extra text");
await until(async () => (await tagged()).length === 2);
await until(async () => (await tagged()).every((run) => run.status === "completed"));
const gate = Object.values((await ports.state()).gates).find((gate) => gate.runId === runId);
print({ recorded: response.kind, retained: await ports.document(gate.outcome.answer), runBound: gate.runId === runId, gateBound: gate.gateId === "design-choice" });
await finished(runId);
`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines[0], {
      recorded: "decision-recorded",
      retained: "earlier with extra text",
      runBound: true,
      gateBound: true,
    });
    const line = result.lines[1];
    assert.deepEqual(field(line, "outcome"), {
      kind: "blocked",
      reason: "answer-invalid",
    });
    assert.deepEqual(field(line, "budget"), { limit: 5, spent: 1 });
    assert.equal(field(line, "turns"), 1);
    assert.equal(field(line, "gates"), 1);
  }));

await test("CLV-148 an unanswered question expires at its original deadline without reopening", () =>
  withConsumer(questionSource, async (consumer) => {
    const result = await consumer.run(`${questionSetup}
const before = (await asked("status", { runId })).run;
const deadline = question.expiresAt;
questionNow = "2026-10-21T09:59:59.999Z";
const pending = (await asked("questions", { runId })).decisions.length;
questionNow = deadline;
const late = await answer("earlier");
await until(async () => (await tagged()).length === 2);
await until(async () => (await tagged()).every((run) => run.status === "completed"));
const settled = await answer("earlier", { commandId: "after-expiry" });
print({ before: before.state, pending, late: late.code, settled: settled.code, deadline });
await finished(runId);
`);
    assert.equal(result.status, 0, result.stderr);
    const observed = result.lines[0];
    assert.equal(field(observed, "before"), "waiting_gate");
    assert.equal(field(observed, "pending"), 1);
    assert.ok(
      ["decision-expired", "decision-not-pending"].includes(
        String(field(observed, "late")),
      ),
    );
    assert.equal(field(observed, "settled"), "decision-not-pending");
    assert.equal(field(observed, "deadline"), "2026-10-21T10:00:00.000Z");
    const line = result.lines[1];
    assert.deepEqual(field(line, "outcome"), {
      kind: "blocked",
      reason: "answer-missing",
    });
    assert.deepEqual(field(line, "budget"), { limit: 5, spent: 1 });
    assert.equal(field(line, "turns"), 1);
    assert.equal(field(line, "gates"), 1);
  }));
