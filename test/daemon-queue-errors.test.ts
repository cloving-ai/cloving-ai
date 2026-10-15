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
`;

function observed(script: string): string {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", prelude + script],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stderr;
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
  const queue = issueQueue({ directory: harness.stateDirectory,
    runtimeDirectory: harness.runtimeDirectory, intervalMilliseconds: 5 });
  try {
    await eventually(() => calls >= replies.length ? true : undefined);
    await delay(50);
    assert.equal(calls, replies.length);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), commands);
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
  for (const value of [null, [""], [1]]) {
    const stderr = observed(`
await withHarness(async (harness) => {
  const file = join(harness.stateDirectory, "queue-commands.json");
  const original = ${JSON.stringify(JSON.stringify(value))};
  await writeFile(file, original);
  const queue = issueQueue({ directory: harness.stateDirectory,
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
  const queue = issueQueue({ directory: harness.stateDirectory,
    runtimeDirectory: harness.runtimeDirectory, intervalMilliseconds: 5 });
  await queue.stop();
});
`);
  assert.equal(stderr.trim().split("\n").length, 1);
  assert.match(stderr, /Queue stopped:.*EISDIR/);
});
