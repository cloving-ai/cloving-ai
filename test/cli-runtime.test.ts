import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  call,
  digestOf,
  eventually,
  field,
  parsed,
  withHarness,
  text,
  waitingGate,
  type Harness,
} from "./service-fixture.ts";

const commands = [
  "run",
  "status",
  "questions",
  "answer",
  "approve",
  "deny",
  "pause",
  "resume",
  "drop",
  "events",
  "watch",
  "start",
];

await test("CLV-008 help lists each runtime command, and each command has its own help", () =>
  withHarness(async (harness) => {
    const help = await harness.cli(["--help"]);
    assert.equal(help.status, 0);
    for (const command of commands) {
      assert.match(help.stdout, new RegExp(`^  ${command} `, "m"));
      const own = await harness.cli([command, "--help"]);
      assert.equal(own.status, 0, command);
      assert.match(own.stdout, new RegExp(`^Usage: cloving ${command}`));
    }
    assert.equal(help.stdout.includes("develop-ticket"), false);
    assert.deepEqual(await readdir(harness.stateDirectory), []);
  }));

await test("CLV-008 a command with no service exits 1 with an actionable error and starts no authority", () =>
  withHarness(async (harness) => {
    const machine = await harness.cli(["status", "--json"]);
    assert.equal(machine.status, 1);
    assert.equal(machine.stderr, "");
    assert.deepEqual(parsed(machine), {
      schemaVersion: 1,
      kind: "error",
      code: "service-unavailable",
      detail: `No Cloving service answers in ${harness.runtimeDirectory}. Start the service, or set CLOVING_RUNTIME_DIR to its runtime directory.`,
      commandId: null,
      runId: null,
      currentRevision: null,
    });
    const human = await harness.cli(["questions"]);
    assert.equal(human.status, 1);
    assert.equal(human.stdout, "");
    assert.match(
      human.stderr,
      /^service-unavailable: No Cloving service answers/,
    );
    assert.deepEqual(await readdir(harness.stateDirectory), []);
  }));

await test("CLV-008 run with a prompt prints the run and receipt identity, and an input file gives the same receipt", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const prompt = "work on “CLV-037”\n  now";
    const first = await harness.cli([
      "run",
      "develop",
      "--prompt",
      prompt,
      "--command-id",
      "c-run",
      "--json",
    ]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, "");
    assert.equal(first.stdout.split("\n").length, 2);
    assert.equal(field(parsed(first), "kind"), "run-admitted");
    await writeFile(
      join(harness.projectDirectory, "input.json"),
      JSON.stringify({ prompt }),
    );
    const second = await harness.cli([
      "run",
      "develop",
      "--input",
      "input.json",
      "--command-id",
      "c-run",
      "--json",
    ]);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(
      field(parsed(second), "receipt"),
      field(parsed(first), "receipt"),
    );
    assert.equal(field(parsed(second), "replayed"), true);
    const human = await harness.cli([
      "run",
      "develop",
      "--prompt",
      "second task",
    ]);
    assert.equal(human.status, 0, human.stderr);
    const generated = /^Command ID: ([A-Za-z0-9._:/-]+)$/m.exec(human.stderr);
    assert.ok(generated);
    assert.match(human.stdout, /^Run run-[0-9a-f]{32} is admitted\.$/m);
    assert.match(
      human.stdout,
      new RegExp(`^Command ID: ${generated[1] ?? ""}$`, "m"),
    );
    assert.match(human.stdout, /^Receipt: sequence \d+, /m);
    assert.equal(human.stdout.includes("second task"), false);
    await service.close();
  }));

await test("CLV-008 an unreadable or malformed input file and a rejected submission exit 1 before admission", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    await writeFile(join(harness.projectDirectory, "bad.json"), "{not json");
    await writeFile(
      join(harness.projectDirectory, "large.json"),
      JSON.stringify({ prompt: "x".repeat(5000) }),
    );
    const cases: readonly (readonly [readonly string[], string])[] = [
      [["--input", "absent.json"], "unreadable-input"],
      [["--input", "bad.json"], "malformed-input"],
      [["--input", "large.json"], "input-too-large"],
    ];
    for (const [source, code] of cases) {
      const result = await harness.cli([
        "run",
        "develop",
        ...source,
        "--command-id",
        "c-1",
        "--json",
      ]);
      assert.deepEqual(
        [
          result.status,
          field(parsed(result), "kind"),
          field(parsed(result), "code"),
        ],
        [1, "error", code],
      );
    }
    const unknown = await harness.cli([
      "run",
      "absent",
      "--prompt",
      "task",
      "--json",
    ]);
    assert.deepEqual(
      [unknown.status, field(parsed(unknown), "code")],
      [1, "unknown-workflow"],
    );
    assert.match(
      text(parsed(unknown), "commandId"),
      /^[A-Za-z0-9._:/-]{1,128}$/,
    );
    const events = await call(harness, {
      operation: "events",
      parameters: { after: 0, limit: 10 },
    });
    assert.deepEqual(field(events, "events"), []);
    await service.close();
  }));

async function suggestedBinding(harness: Harness): Promise<readonly string[]> {
  const listed = await harness.cli(["questions"]);
  assert.equal(listed.status, 0, listed.stderr);
  const suggested = /^ {2}cloving approve (.+)$/m.exec(listed.stdout);
  assert.ok(suggested);
  return String(suggested[1]).split(" ");
}

await test("CLV-008 answer, approve and deny exit 0 only after the commit and print the receipt identity, and a changed request under a known command ID exits 1", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    const binding = await suggestedBinding(harness);
    assert.equal(
      binding.join(" "),
      `${waiting.decisionId} --expected-revision 1 --generation 1 --subject-digest ${digestOf("approval of c-1?")}`,
    );
    const stale = await harness.cli([
      "deny",
      ...binding.map((part) => (part === "1" ? "2" : part)),
      "--json",
    ]);
    assert.deepEqual(
      [
        stale.status,
        field(parsed(stale), "kind"),
        field(parsed(stale), "code"),
      ],
      [1, "error", "stale-revision"],
    );
    const approved = await harness.cli([
      "approve",
      ...binding,
      "--command-id",
      "c-approve",
    ]);
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(
      approved.stdout,
      new RegExp(
        `^Decision ${waiting.decisionId} is recorded as approved\\.$`,
        "m",
      ),
    );
    assert.match(approved.stdout, /^Command ID: c-approve$/m);
    assert.match(approved.stdout, /^Receipt: sequence \d+, /m);
    assert.match(approved.stdout, /^Continuation: admitted$/m);
    const conflict = await harness.cli([
      "deny",
      ...binding,
      "--command-id",
      "c-approve",
      "--json",
    ]);
    assert.deepEqual(
      [
        conflict.status,
        field(parsed(conflict), "code"),
        field(parsed(conflict), "commandId"),
      ],
      [1, "conflicting-command", "c-approve"],
    );
    await service.close();
  }));

await test("CLV-008 status and pause print the committed state of a run", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "question",
    });
    const list = await harness.cli(["status"]);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /^Pending decisions:\n {2}Q1 /m);
    assert.match(
      list.stdout,
      new RegExp(
        `^  ${waiting.runId}  develop  waiting-decision  revision 3$`,
        "m",
      ),
    );
    const one = await harness.cli(["status", waiting.runId, "--json"]);
    assert.equal(
      field(field(parsed(one), "run"), "condition"),
      "waiting-decision",
    );
    const paused = await harness.cli([
      "pause",
      waiting.runId,
      "--expected-revision",
      "3",
      "--command-id",
      "c-pause",
    ]);
    assert.equal(paused.status, 0, paused.stderr);
    assert.match(
      paused.stdout,
      new RegExp(
        `^Run ${waiting.runId}: pause is committed\\. State paused, revision 4\\.$`,
        "m",
      ),
    );
    assert.match(paused.stdout, /^Observed: paused$/m);
    await service.close();
  }));

await test("CLV-008 drop prints the committed state, and a usage error on a runtime command exits 2", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "question",
    });
    const dropped = await harness.cli([
      "drop",
      waiting.runId,
      "--expected-revision",
      "3",
      "--json",
    ]);
    assert.deepEqual(
      [dropped.status, field(field(parsed(dropped), "committed"), "state")],
      [0, "cancelled"],
    );
    const usage = await harness.cli(["pause", waiting.runId, "--json"]);
    assert.equal(usage.status, 2);
    assert.deepEqual(parsed(usage), {
      schemaVersion: 1,
      kind: "usage-error",
      code: "missing-option",
    });
    const sources = await harness.cli([
      "run",
      "develop",
      "--prompt",
      "a",
      "--input",
      "b",
    ]);
    assert.equal(sources.status, 2);
    assert.match(sources.stderr, /^conflicting-input-sources: /);
    await service.close();
  }));

await test("CLV-008 events prints one event object on each line, an explicit gap exits 1, and a follow ends with exit 0 on a signal", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    await waitingGate(harness, { service, commandId: "c-1", kind: "question" });
    const page = await harness.cli([
      "events",
      "--after",
      "1",
      "--limit",
      "2",
      "--json",
    ]);
    assert.equal(page.status, 0, page.stderr);
    const lines = page.stdout.split("\n").filter((line) => line.length > 0);
    assert.deepEqual(
      lines.map((line) => field(JSON.parse(line), "sequence")),
      [2, 3],
    );
    assert.equal(page.stdout.includes("question of c-1"), false);
    const gap = await harness.cli(["events", "--after", "99", "--json"]);
    assert.equal(gap.status, 1);
    assert.deepEqual(parsed(gap), {
      schemaVersion: 1,
      kind: "event-gap",
      after: 99,
      earliestAvailable: 1,
      latestSequence: 5,
    });
    const follower = spawn(
      process.execPath,
      [resolve("src/cli.ts"), "events", "--follow", "--json"],
      {
        env: { ...process.env, CLOVING_RUNTIME_DIR: harness.runtimeDirectory },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    follower.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    try {
      await eventually(() =>
        output.split("\n").filter((line) => line.length > 0).length === 5
          ? true
          : undefined,
      );
      follower.kill("SIGTERM");
      const exited: readonly unknown[] = await once(follower, "exit");
      assert.equal(exited[0], 0);
    } finally {
      follower.kill("SIGKILL");
    }
    await service.close();
  }));
