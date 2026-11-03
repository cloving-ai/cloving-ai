import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { commandUsage, usage as topUsage } from "../src/cli/usage.ts";
import type { QueueDrain, QueuePort } from "../src/queue-state.ts";
import { parsed, withHarness, type Harness } from "./service-fixture.ts";

const startedAt = Date.parse("2026-11-03T10:00:00.000Z");

function memoryPort(): QueuePort {
  let failedRunIds: readonly string[] = ["run-a", "run-b", "run-c"];
  let drain: QueueDrain | undefined;
  return {
    control: () => ({ failedRunIds, drain, error: undefined }),
    change: ({ command }) => {
      drain =
        command === "drain" ? { startedAt, drainedAt: startedAt } : undefined;
      if (command === "resume") failedRunIds = [];
      return Promise.resolve({ kind: "changed" });
    },
  };
}

async function withQueue(
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  await withHarness(async (harness) => {
    await harness.start({
      workflows: [
        {
          ...harness.registration,
          manifest: { ...harness.registration.manifest, queue: true },
          admission: 2,
        },
      ],
      queue: memoryPort(),
    });
    await body(harness);
  });
}

await test("CLV-273 cloving queue shows a stopped queue with its reason and failed runs", () =>
  withQueue(async (harness) => {
    const plain = await harness.cli(["queue"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(
      plain.stdout,
      [
        "Queue: stopped, 0 of 2 lanes busy",
        "Stop reason: failure-limit",
        "Failed runs in a row: run-a, run-b, run-c",
        "",
      ].join("\n"),
    );
    const json = await harness.cli(["queue", "--json"]);
    assert.equal(json.status, 0, json.stdout);
    const result = parsed(json);
    assert.equal(result["kind"], "queue");
    const queue = result["queue"];
    assert.ok(queue !== null && typeof queue === "object");
    assert.equal(Reflect.get(queue, "state"), "stopped");
  }));

await test("CLV-273 cloving queue drain and resume send queue commands with a command ID", () =>
  withQueue(async (harness) => {
    const drained = await harness.cli([
      "queue",
      "drain",
      "--command-id",
      "drain-one",
      "--json",
    ]);
    assert.equal(drained.status, 0, drained.stdout);
    const result = parsed(drained);
    assert.equal(result["kind"], "queue-command");
    assert.equal(result["command"], "drain");
    assert.equal(result["commandId"], "drain-one");
    assert.equal(result["replayed"], false);
    const plain = await harness.cli(["queue"]);
    assert.match(
      plain.stdout,
      /^Queue: drained, 0 of 2 lanes busy\nStop reason: failure-limit\n/,
    );
    assert.match(
      plain.stdout,
      /\nDrain started: 2026-11-03T10:00:00.000Z\nDrained: 2026-11-03T10:00:00.000Z\n$/,
    );
    const resumed = await harness.cli(["queue", "resume"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.stdout, "Queue: running, 0 of 2 lanes busy\n");
    assert.match(resumed.stderr, /^Command ID: \S+\n$/);
  }));

await test("CLV-273 cloving queue reports a service with no queue", () =>
  withHarness(async (harness) => {
    await harness.start();
    const plain = await harness.cli(["queue", "drain"]);
    assert.equal(plain.status, 1);
    assert.match(plain.stderr, /queue-unavailable/);
    const json = await harness.cli(["queue", "--json"]);
    assert.equal(parsed(json)["code"], "queue-unavailable");
  }));

await test("CLV-273 queue arguments refuse unknown actions, extra values and misplaced options", () => {
  for (const [args, code] of [
    [["pause"], "invalid-queue-action"],
    [["drain", "extra"], "unexpected-argument"],
    [["--command-id", "one"], "unexpected-option"],
    [["resume", "--limit", "2"], "unexpected-option"],
    [["drain", "--command-id", "bad id"], "invalid-option-value"],
  ] as const) {
    const invocation = parseInvocation(["queue", ...args]);
    assert.equal(invocation.kind, "usage-error", JSON.stringify(args));
    assert.equal(
      "code" in invocation ? invocation.code : undefined,
      code,
      JSON.stringify(args),
    );
  }
  assert.deepEqual(parseInvocation(["queue", "drain", "--json"]), {
    kind: "queue",
    action: "drain",
    commandId: null,
    json: true,
  });
});

await test("CLV-273 the help names the queue commands and the drain end of the queue reset", () => {
  const help = String(commandUsage["queue"]);
  assert.match(help, /^Usage: cloving queue \[--json\]\n/);
  assert.match(help, /cloving queue resume \[--command-id <id>\] \[--json\]/);
  assert.match(help, /cloving queue drain \[--command-id <id>\] \[--json\]/);
  assert.match(help, /running, stopped, draining or drained/);
  assert.match(help, /restart/);
  assert.match(topUsage, /\n {2}queue +Show, resume and drain the queue\.\n/);
  assert.match(String(commandUsage["start"]), /cloving queue resume/);
  assert.match(
    String(commandUsage["start"]),
    /--reset-queue.*also ends a drain/,
  );
});
