import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { record } from "../src/protocol.ts";
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

const prompt = "Which parser is correct for the input format?";
const question = {
  commandId: "w-open",
  expectedRevision: 2,
  gateId: "design-1",
  kind: "question",
  prompt,
  subject: digestOf(prompt),
} as const;

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

interface Host {
  readonly process: ChildProcess;
  readonly lines: string[];
  readonly submit: (
    command: Readonly<Record<string, unknown>>,
    documents?: readonly string[],
  ) => Promise<unknown>;
}

async function host(harness: Harness, mode: string): Promise<Host> {
  const child = spawn(
    process.execPath,
    [
      resolve("test/service-host.ts"),
      harness.stateDirectory,
      harness.runtimeDirectory,
      join(harness.stateDirectory, "deliveries.jsonl"),
      mode,
    ],
    {
      env: { ...process.env, NODE_V8_COVERAGE: undefined },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  harness.cleanup(() => {
    child.kill("SIGKILL");
  });
  const lines: string[] = [];
  createInterface({ input: child.stdout }).on("line", (line) =>
    lines.push(line),
  );
  await eventually(() => (lines.includes("ready") ? true : undefined));
  return {
    process: child,
    lines,
    submit: async (command, documents = []) => {
      const before = lines.filter((line) => line.startsWith("result ")).length;
      child.stdin.write(`${JSON.stringify({ command, documents })}\n`);
      return eventually(() => {
        const results = lines.filter((line) => line.startsWith("result "));
        const [line] = results.slice(before);
        return line === undefined
          ? undefined
          : record(JSON.parse(line.slice("result ".length)));
      });
    },
  };
}

async function continuations(harness: Harness): Promise<readonly unknown[]> {
  const lines = await readFile(
    join(harness.stateDirectory, "deliveries.jsonl"),
    "utf8",
  ).catch(() => "");
  return lines
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line))
    .filter((intent) => field(intent, "kind") === "continue-run");
}

async function openedQuestion(first: Host, runId: string): Promise<void> {
  await first.submit({
    kind: "mark-started",
    runId,
    commandId: "w-started",
    expectedRevision: 1,
  });
  await first.submit(
    {
      kind: "open-gate",
      runId,
      commandId: "w-open",
      expectedRevision: 2,
      gateId: "design-1",
      gateKind: "question",
      subject: digestOf(prompt),
      prompt: digestOf(prompt),
    },
    [prompt],
  );
  await first.submit({
    kind: "register-wait",
    runId,
    commandId: "w-wait",
    gateId: "design-1",
  });
}

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
