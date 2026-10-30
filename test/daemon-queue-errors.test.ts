import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type { Reply } from "../src/protocol.ts";

const prelude = `
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { issueQueue } from "./src/daemon/issue-queue.ts";
import { listen } from "./src/service/transport.ts";
import { eventually, withHarness } from "./test/service-fixture.ts";
const commandIds = async (file) => {
  const value = JSON.parse(await readFile(file, "utf8"));
  return Array.isArray(value) ? value : value.commands;
};
`;

function observation(script: string): { stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", prelude + script],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return { stdout: result.stdout, stderr: result.stderr };
}

function observed(script: string): string {
  return observation(script).stderr;
}

function statusFailure(options: {
  readonly commands: readonly string[];
  readonly replies: readonly Reply[];
}): string {
  return observed(`
await withHarness(async (harness) => {
  const file = join(harness.stateDirectory, "queue-commands.json");
  const commands = ${JSON.stringify(options.commands)};
  const replies = ${JSON.stringify(options.replies)};
  await writeFile(file, JSON.stringify(commands));
  let calls = 0;
  const listener = await listen({
    path: join(harness.runtimeDirectory, "control.sock"),
    handle: async () => replies[Math.min(calls++, replies.length - 1)],
    limits: { idleMilliseconds: 5000 },
  });
  const queue = issueQueue({ workflowId: "develop-issue", directory: harness.stateDirectory,
    runtimeDirectory: harness.runtimeDirectory, intervalMilliseconds: 5 });
  try {
    await eventually(() => calls >= replies.length ? true : undefined);
    await delay(50);
    assert.equal(calls, replies.length);
    assert.deepEqual(await commandIds(file), commands);
  } finally {
    await queue.stop();
    await listener.close();
  }
});
`);
}

function refused(code: string): Reply {
  return { kind: "error", error: { code, detail: code } };
}

await test("CLV-084 unavailable or malformed status replies stop polling without discarding tracked commands", () => {
  const cases = [
    {
      commands: ["pending"],
      reply: refused("authority-unavailable"),
      code: "authority-unavailable",
    },
    {
      commands: ["pending"],
      reply: { kind: "result", result: { run: null } },
      code: "invalid-run-status",
    },
    {
      commands: [],
      reply: refused("service-unavailable"),
      code: "service-unavailable",
    },
    {
      commands: [],
      reply: { kind: "result", result: { runs: null } },
      code: "invalid-run-list",
    },
    {
      commands: [],
      reply: { kind: "result", result: { runs: [], next: "" } },
      code: "invalid-run-page",
    },
    {
      commands: [],
      reply: { kind: "result", result: { runs: [], next: 1 } },
      code: "invalid-run-page",
    },
  ] satisfies readonly {
    readonly commands: readonly string[];
    readonly reply: Reply;
    readonly code: string;
  }[];
  for (const entry of cases)
    assert.equal(
      statusFailure({ commands: entry.commands, replies: [entry.reply] }),
      `Queue stopped: ${JSON.stringify(entry.code)}\n`,
    );
});

await test("CLV-084 a tracked run disappearing after recovery stops the queue and preserves its command", () => {
  assert.equal(
    statusFailure({
      commands: ["pending"],
      replies: [
        { kind: "result", result: { run: { state: "running" } } },
        refused("unknown-run"),
      ],
    }),
    'Queue stopped: "queue-run-missing"\n',
  );
});

await test("CLV-084 invalid command journals stop polling without replacing the journal", () => {
  for (const value of [
    null,
    [""],
    [1],
    {},
    { commands: [], failures: [1] },
    { commands: [], failures: ["a", "b", "c", "d"] },
  ]) {
    const stderr = observed(`
await withHarness(async (harness) => {
  const file = join(harness.stateDirectory, "queue-commands.json");
  const original = ${JSON.stringify(JSON.stringify(value))};
  await writeFile(file, original);
  const queue = issueQueue({ workflowId: "develop-issue", directory: harness.stateDirectory,
    runtimeDirectory: harness.runtimeDirectory, intervalMilliseconds: 5 });
  await queue.stop();
  assert.equal(await readFile(file, "utf8"), original);
});
`);
    assert.equal(stderr, 'Queue stopped: "invalid-queue-commands"\n');
  }
});

await test("CLV-084 unreadable command journals stop polling with one diagnostic", () => {
  const stderr = observed(`
await withHarness(async (harness) => {
  await mkdir(join(harness.stateDirectory, "queue-commands.json"));
  const queue = issueQueue({ workflowId: "develop-issue", directory: harness.stateDirectory,
    runtimeDirectory: harness.runtimeDirectory, intervalMilliseconds: 5 });
  await queue.stop();
});
`);
  assert.equal(stderr.trim().split("\n").length, 1);
  assert.match(stderr, /Queue stopped:.*EISDIR/);
});

function retriedSubmission(code: string) {
  return observation(`
await withHarness(async (harness) => {
  const file = join(harness.stateDirectory, "queue-commands.json");
  let commandId;
  const listener = await listen({
    path: join(harness.runtimeDirectory, "control.sock"),
    handle: async (request) => {
      if (request.operation !== "run")
        return { kind: "result", result: { runs: [], next: null } };
      commandId = request.parameters.commandId;
      return { kind: "error", error: { code: ${JSON.stringify(code)}, detail: "Retry." } };
    },
    limits: { idleMilliseconds: 5000 },
  });
  const queue = issueQueue({ workflowId: "develop-issue", directory: harness.stateDirectory,
    runtimeDirectory: harness.runtimeDirectory, intervalMilliseconds: 200 });
  try {
    await eventually(() => commandId ? true : undefined);
    await delay(50);
    assert.deepEqual(await commandIds(file), [commandId]);
  } finally {
    await queue.stop();
    await listener.close();
  }
  assert.match(commandId, /^[0-9a-f-]{36}$/);
  process.stdout.write(commandId);
});
`);
}

await test("CLV-092 a resolver timeout reports a retry and keeps its command without stopping", () => {
  const output = retriedSubmission("resolver-timeout");
  assert.equal(
    output.stderr,
    `Queue resolver-timeout: command ${output.stdout}; will retry\n`,
  );
});

await test("CLV-102 an unavailable next-ticket command reports one retry and keeps its command without stopping", () => {
  const output = retriedSubmission("next-ticket-not-available");
  assert.equal(
    output.stderr,
    `Queue next-ticket-not-available: command ${output.stdout}; will retry\n`,
  );
});

await test("CLV-102 an unavailable ticket command reports one retry and keeps its command without stopping", () => {
  const output = retriedSubmission("ticket-not-available");
  assert.equal(
    output.stderr,
    `Queue ticket-not-available: command ${output.stdout}; will retry\n`,
  );
});

await test("CLV-102 an unavailable next-ticket command admits one run with the same request on the next cycle", () => {
  const output = observation(`
await withHarness(async (harness) => {
  const file = join(harness.stateDirectory, "queue-commands.json");
  const requests = [];
  const intervalMilliseconds = 40;
  let refusedAt = 0;
  let admissions = 0;
  let runReads = 0;
  const listener = await listen({
    path: join(harness.runtimeDirectory, "control.sock"),
    handle: async (request) => {
      if (request.operation !== "run" && request.parameters.runId === undefined)
        return { kind: "result", result: { runs: [], next: null } };
      if (request.operation !== "run") {
        assert.equal(admissions, 1);
        runReads += 1;
        return { kind: "result", result: { run: { state: "running" } } };
      }
      requests.push(request);
      assert.deepEqual(await commandIds(file), [request.parameters.commandId]);
      if (requests.length === 1) {
        refusedAt = performance.now();
        return { kind: "error", error: { code: "next-ticket-not-available", detail: "Retry." } };
      }
      assert.deepEqual(request, requests[0]);
      assert.ok(performance.now() - refusedAt >= intervalMilliseconds - 1);
      admissions += 1;
      return { kind: "result", result: { kind: "run-admitted" } };
    },
    limits: { idleMilliseconds: 5000 },
  });
  const queue = issueQueue({ workflowId: "develop-issue", directory: harness.stateDirectory,
    runtimeDirectory: harness.runtimeDirectory, intervalMilliseconds });
  try {
    await eventually(() => runReads >= 2 ? true : undefined);
    assert.equal(requests.length, 2);
    assert.equal(admissions, 1);
    assert.deepEqual(await commandIds(file), [requests[0].parameters.commandId]);
    process.stdout.write(requests[0].parameters.commandId);
  } finally {
    await queue.stop();
    await listener.close();
  }
});
`);
  assert.equal(
    output.stderr,
    `Queue next-ticket-not-available: command ${output.stdout}; will retry\n`,
  );
});

function stoppedSubmission(codes: readonly string[]) {
  return observation(`
await withHarness(async (harness) => {
  const file = join(harness.stateDirectory, "queue-commands.json");
  const codes = ${JSON.stringify(codes)};
  const requests = [];
  const listener = await listen({
    path: join(harness.runtimeDirectory, "control.sock"),
    handle: async (request) => {
      if (request.operation !== "run")
        return request.parameters.runId === undefined
          ? { kind: "result", result: { runs: [], next: null } }
          : { kind: "error", error: { code: "unknown-run", detail: "Not admitted." } };
      requests.push(request);
      assert.deepEqual(await commandIds(file), [request.parameters.commandId]);
      const code = codes[requests.length - 1];
      return { kind: "error", error: { code, detail: code } };
    },
    limits: { idleMilliseconds: 5000 },
  });
  const queue = issueQueue({ workflowId: "develop-issue", directory: harness.stateDirectory,
    runtimeDirectory: harness.runtimeDirectory, intervalMilliseconds: 10 });
  try {
    await eventually(() => requests.length === codes.length ? true : undefined);
    await delay(60);
    assert.equal(requests.length, codes.length);
    assert.ok(requests.every((request) => JSON.stringify(request) === JSON.stringify(requests[0])));
    assert.deepEqual(await commandIds(file), [requests[0].parameters.commandId]);
    process.stdout.write(requests[0].parameters.commandId);
  } finally {
    await queue.stop();
    await listener.close();
  }
});
`);
}

await test("CLV-092 resolver and ticket failures stop once and retain the command, including after timeouts", () => {
  for (const code of [
    "resolver-failure",
    "invalid-ticket-id",
    "next-source-not-configured",
  ]) {
    for (const preceding of [[], ["resolver-timeout", "resolver-timeout"]]) {
      const output = stoppedSubmission([...preceding, code]);
      assert.equal(
        output.stderr,
        preceding
          .map(
            () =>
              `Queue resolver-timeout: command ${output.stdout}; will retry\n`,
          )
          .join("") + `Queue stopped: ${JSON.stringify(code)}\n`,
      );
    }
  }
});

await test("CLV-092 empty and active refusals retire a timed-out command and allow a new ID", () => {
  for (const code of ["no-ready-ticket", "workflow-active"]) {
    const output = observation(`
await withHarness(async (harness) => {
  const file = join(harness.stateDirectory, "queue-commands.json");
  const requests = [];
  const released = Promise.withResolvers();
  let retired = false;
  const listener = await listen({
    path: join(harness.runtimeDirectory, "control.sock"),
    handle: async (request) => {
      if (request.operation !== "run" && requests.length === 2) {
        assert.deepEqual(await commandIds(file), []);
        retired = true;
      }
      if (request.operation !== "run")
        return { kind: "result", result: { runs: [], next: null } };
      requests.push(request);
      assert.deepEqual(await commandIds(file), [request.parameters.commandId]);
      if (requests.length === 3) await released.promise;
      const code = requests.length === 1 ? "resolver-timeout" : ${JSON.stringify(code)};
      return { kind: "error", error: { code, detail: code } };
    },
    limits: { idleMilliseconds: 5000 },
  });
  const queue = issueQueue({ workflowId: "develop-issue", directory: harness.stateDirectory,
    runtimeDirectory: harness.runtimeDirectory, intervalMilliseconds: 20 });
  try {
    await eventually(() => requests.length === 3 ? true : undefined);
    assert.equal(retired, true);
    assert.deepEqual(requests[1], requests[0]);
    assert.notEqual(requests[2].parameters.commandId, requests[0].parameters.commandId);
    process.stdout.write(requests[0].parameters.commandId);
  } finally {
    released.resolve();
    await queue.stop();
    await listener.close();
  }
});
`);
    assert.equal(
      output.stderr,
      `Queue resolver-timeout: command ${output.stdout}; will retry\n`,
    );
  }
});
