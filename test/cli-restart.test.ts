import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseInvocation } from "../src/cli/arguments.ts";
import { restartCommand } from "../src/cli/restart-command.ts";
import { commandUsage } from "../src/cli/usage.ts";
import { record } from "../src/protocol.ts";
import type { RestartMark, RestartPort } from "../src/restart-request.ts";
import type { Service } from "../src/service/service.ts";
import { withHarness, type Harness } from "./service-fixture.ts";

const before = {
  version: "1.6.0",
  commit: "1111111111111111111111111111111111111111",
  startedAt: "2026-11-05T10:00:00.000Z",
};
const after = {
  version: "1.6.0",
  commit: "2222222222222222222222222222222222222222",
  startedAt: "2026-11-05T10:05:00.000Z",
};

interface Running {
  service?: Service;
  restarting?: Promise<void>;
  readonly marks: RestartMark[];
}

function restartingPort(harness: Harness, running: Running): RestartPort {
  return {
    pending: () => Promise.resolve(running.marks.at(-1)),
    request: (mark) => {
      running.marks.push(mark);
      running.restarting = delay(300).then(async () => {
        await running.service?.close();
        running.service = await harness.start({ ...after });
      });
      return Promise.resolve();
    },
    cancel: () =>
      Promise.resolve(
        running.marks.splice(0).length > 0 ? "cancelled" : "none",
      ),
    unresumable: () => Promise.resolve(["run-shell"]),
  };
}

await test("CLV-306 cloving restart waits for the new daemon and prints both commits and its start time", () =>
  withHarness(async (harness) => {
    const running: Running = {
      marks: [],
    };
    running.service = await harness.start({
      restart: restartingPort(harness, running),
      ...before,
    });
    const result = await harness.cli([
      "restart",
      "--command-id",
      "restart-one",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        "Restart pending: 0 runs active",
        `Restarted: commit ${before.commit} -> ${after.commit}`,
        `Started at: ${after.startedAt}`,
        "",
      ].join("\n"),
    );
    assert.deepEqual(
      running.marks.map((mark) => [mark.at, mark.commandId, mark.resumeQueue]),
      [["gap", "restart-one", false]],
    );
  }));

await test("CLV-306 cloving restart --json prints the pending reply and then the restarted daemon", () =>
  withHarness(async (harness) => {
    const running: Running = {
      marks: [],
    };
    running.service = await harness.start({
      restart: restartingPort(harness, running),
      ...before,
    });
    const result = await harness.cli([
      "restart",
      "--at",
      "now",
      "--json",
      "--resume-queue",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const [pending, restarted] = result.stdout
      .trim()
      .split("\n")
      .map((line) => record(JSON.parse(line)));
    assert.equal(pending?.["kind"], "restart");
    assert.deepEqual(record(pending["restart"])?.["unresumableRuns"], [
      "run-shell",
    ]);
    assert.deepEqual(restarted, {
      kind: "restarted",
      previousCommit: before.commit,
      commit: after.commit,
      startedAt: after.startedAt,
    });
    const [first] = running.marks;
    assert.ok(first);
    assert.equal(first.at, "now");
    assert.equal(first.resumeQueue, true);
  }));

await test("CLV-306 cloving restart --cancel cancels a pending restart", () =>
  withHarness(async (harness) => {
    const running: Running = {
      marks: [
        {
          at: "gap",
          requestedAt: 1,
          commandId: "restart-one",
          resumeQueue: false,
        },
      ],
    };
    running.service = await harness.start({
      restart: restartingPort(harness, running),
      ...before,
    });
    const status = await harness.cli(["status"]);
    assert.match(status.stdout, /^Restart pending: 0 runs active$/m);
    assert.match(
      status.stdout,
      new RegExp(
        `^Service: commit ${before.commit}, started at ${before.startedAt}$`,
        "m",
      ),
    );
    const cancelled = await harness.cli(["restart", "--cancel"]);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(cancelled.stdout, "Restart: cancelled\n");
    const none = await harness.cli(["restart", "--cancel"]);
    assert.equal(none.stdout, "Restart: none pending\n");
  }));

const codeOf = (argumentsList: readonly string[]): unknown =>
  record(parseInvocation(argumentsList))?.["code"];

await test("CLV-306 cloving restart refuses an unknown time and a cancel with a time", () => {
  assert.equal(codeOf(["restart", "--at", "later"]), "invalid-option-value");
  assert.equal(
    codeOf(["restart", "--cancel", "--at", "now"]),
    "unexpected-option",
  );
  assert.equal(codeOf(["restart", "extra"]), "unexpected-argument");
  assert.match(String(commandUsage["restart"]), /--at gap\|now/);
  assert.match(String(commandUsage["restart"]), /--resume-queue/);
});

async function directRestart(
  harness: Harness,
  options: {
    readonly commandId: string;
    readonly interrupted: () => Promise<void>;
  },
): Promise<{
  readonly code: number;
  readonly out: readonly string[];
  readonly error: readonly string[];
}> {
  const out: string[] = [];
  const error: string[] = [];
  const code = await restartCommand(
    {
      runtimeDirectory: harness.runtimeDirectory,
      terminal: {
        out: (text) => out.push(text),
        error: (text) => error.push(text),
      },
      identifier: () => options.commandId,
      interrupted: options.interrupted,
    },
    {
      kind: "restart",
      at: "gap",
      cancel: false,
      resumeQueue: false,
      commandId: null,
      json: false,
    },
  );
  return { code, out, error };
}

function waitingPort(
  marks: RestartMark[],
  afterRequest: () => void = () => undefined,
): RestartPort {
  return {
    pending: () => Promise.resolve(marks.at(-1)),
    request: (mark) => {
      marks.push(mark);
      afterRequest();
      return Promise.resolve();
    },
    cancel: () => Promise.resolve("none"),
    unresumable: () => Promise.resolve([]),
  };
}

await test("CLV-306 an interrupted wait keeps the restart pending and exits with 130", () =>
  withHarness(async (harness) => {
    const marks: RestartMark[] = [];
    await harness.start({ restart: waitingPort(marks), ...before });
    const { code, out, error } = await directRestart(harness, {
      commandId: "restart-two",
      interrupted: () => Promise.resolve(),
    });
    assert.equal(code, 130);
    assert.deepEqual(out, ["Restart pending: 0 runs active\n"]);
    assert.deepEqual(error, [
      "Command ID: restart-two\n",
      "The restart stays pending. Cancel it with: cloving restart --cancel\n",
    ]);
    assert.deepEqual(
      marks.map((mark) => mark.commandId),
      ["restart-two"],
    );
  }));

await test("CLV-306 a cancel from another terminal ends the wait with restart-cancelled", () =>
  withHarness(async (harness) => {
    const marks: RestartMark[] = [];
    await harness.start({
      restart: waitingPort(marks, () => {
        setTimeout(() => marks.splice(0), 300);
      }),
      ...before,
    });
    const { code, out, error } = await directRestart(harness, {
      commandId: "restart-three",
      interrupted: () => delay(5000),
    });
    assert.deepEqual(error, [
      "Command ID: restart-three\n",
      "restart-cancelled: Another command cancelled the restart before it started.\n",
    ]);
    assert.equal(code, 1);
    assert.deepEqual(out, ["Restart pending: 0 runs active\n"]);
  }));

await test("CLV-306 cloving restart prints the refusal of a service that cannot restart", () =>
  withHarness(async (harness) => {
    await harness.start({ ...before });
    const result = await harness.cli(["restart", "--command-id", "one"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^restart-unavailable: /m);
    assert.equal(result.stdout, "");
  }));
