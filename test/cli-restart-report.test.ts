import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import type { RestartInvocation } from "../src/cli/restart-arguments.ts";
import { restartCommand } from "../src/cli/restart-command.ts";
import { socketAddress } from "../src/broker/socket-address.ts";
import {
  parseRequest,
  record,
  replyLine,
  type Fields,
} from "../src/protocol.ts";

const old = {
  serviceCommit: "1111111111111111111111111111111111111111",
  serviceStartedAt: "2026-11-06T10:00:00.000Z",
};
const fresh = {
  serviceCommit: "2222222222222222222222222222222222222222",
  serviceStartedAt: "2026-11-06T10:05:00.000Z",
};
const requestedAt = 1_793_000_000_000;
const pending = {
  kind: "restart",
  ...old,
  restart: {
    state: "pending",
    activeRuns: 0,
    requestedAt,
    queueWorkflowId: "develop",
    scheduledWorkflowIds: ["nightly"],
  },
};

type Answer = Fields | "down";

interface Scene {
  readonly statuses: readonly Answer[];
  readonly claimed?: {
    readonly removedAfter: number;
    readonly hostProcessId: number;
  };
  readonly invocation?: Partial<RestartInvocation>;
}

function scriptedServer(scene: Scene, claimedFile: string) {
  const requests: Fields[] = [];
  const answers = [...scene.statuses];
  let polled = 0;
  const server = createServer((socket) => {
    socket.once("data", (chunk: Buffer) => {
      const parsed = parseRequest(chunk.toString().trim());
      if (parsed.kind !== "request") return;
      requests.push({ ...parsed.request });
      if (parsed.request.operation === "restart") {
        socket.end(replyLine({ kind: "result", result: pending }));
        return;
      }
      polled += 1;
      if (polled === scene.claimed?.removedAfter)
        rm(claimedFile, { force: true }).catch(() => undefined);
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer === undefined || answer === "down") socket.destroy();
      else socket.end(replyLine({ kind: "result", result: answer }));
    });
  });
  return { server, requests };
}

async function scripted(scene: Scene): Promise<{
  readonly code: number;
  readonly out: string;
  readonly error: string;
  readonly requests: readonly Fields[];
}> {
  const root = await mkdtemp(join(tmpdir(), "cloving-restart-report-"));
  const runtimeDirectory = join(root, "run");
  const claimed = join(dirname(runtimeDirectory), "claimed-restart");
  if (scene.claimed !== undefined)
    await writeFile(
      claimed,
      JSON.stringify({ hostProcessId: scene.claimed.hostProcessId }),
    );
  const { server, requests } = scriptedServer(scene, claimed);
  await mkdir(runtimeDirectory, { mode: 0o700 });
  const address = socketAddress(join(runtimeDirectory, "control.sock"));
  assert.equal(address.kind, "address");
  await new Promise<void>((ready) => server.listen(address.path, ready));
  const out: string[] = [];
  const error: string[] = [];
  try {
    const code = await restartCommand(
      {
        runtimeDirectory,
        terminal: {
          out: (text) => out.push(text),
          error: (text) => error.push(text),
        },
        identifier: () => "restart-report",
        interrupted: () => new Promise(() => undefined),
        answerMilliseconds: 600,
      },
      {
        kind: "restart",
        at: "gap",
        cancel: false,
        resumeQueue: false,
        settings: "environment",
        update: false,
        within: null,
        commandId: null,
        json: false,
        ...scene.invocation,
      },
    );
    return { code, out: out.join(""), error: error.join(""), requests };
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}

const waitingOld = { ...old, restart: pending.restart };

await test("CLV-320 the start report prints both commits, the lanes and each workflow with its admission result", async () => {
  const result = await scripted({
    statuses: [
      waitingOld,
      "down",
      {
        ...fresh,
        restart: null,
        queue: { workflowId: "develop", lanes: 4 },
        workflows: ["develop", "nightly"],
        workflowRefusals: [
          { scope: "user", label: "draft.ts", codes: ["compile-failed"] },
        ],
      },
    ],
  });
  assert.equal(result.code, 0, result.error);
  assert.equal(
    result.out,
    [
      "Restart pending: 0 runs active",
      `Restarted: commit ${old.serviceCommit} -> ${fresh.serviceCommit}`,
      `Started at: ${fresh.serviceStartedAt}`,
      "Lanes: 4",
      "Workflow develop: admitted",
      "Workflow nightly: admitted",
      "Workflow draft.ts: refused: compile-failed",
      "",
    ].join("\n"),
  );
});

await test("CLV-320 a refused queue workflow or scheduled workflow gives a non-zero exit code with its refusal codes", async () => {
  const result = await scripted({
    statuses: [
      waitingOld,
      {
        ...fresh,
        restart: null,
        workflows: [],
        workflowRefusals: [
          {
            scope: "user",
            label: "develop.ts",
            codes: ["compile-failed", "missing-export"],
          },
          { scope: "user", label: "nightly.ts", codes: ["undeclared-effect"] },
        ],
      },
    ],
  });
  assert.equal(result.code, 1);
  assert.match(
    result.out,
    /Workflow develop\.ts: refused: compile-failed, missing-export/,
  );
  assert.equal(
    result.error,
    [
      "Command ID: restart-report",
      "restart-workflow-refused: The service restarted, but it refused these workflows:",
      "    queue workflow develop: compile-failed, missing-export",
      "    scheduled workflow nightly: undeclared-effect",
      "",
    ].join("\n"),
  );
});

await test("CLV-320 a restart cancelled at its deadline prints the active runs and exits 1", async () => {
  const result = await scripted({
    statuses: [
      waitingOld,
      {
        ...old,
        restart: null,
        restartFailure: {
          commandId: "restart-report",
          requestedAt,
          code: "restart-deadline",
          step: "wait",
          output: "Active runs: run-busy",
        },
      },
    ],
    invocation: { within: 1 },
  });
  assert.equal(result.code, 1);
  assert.equal(
    result.error,
    [
      "Command ID: restart-report",
      "restart-deadline: No gap came before the deadline. The restart is cancelled and the queue hold ended.",
      "    Active runs: run-busy",
      "",
    ].join("\n"),
  );
  assert.equal(record(result.requests[0]?.["parameters"])?.["within"], 1);
});

await test("CLV-320 a failed update after the restart prints the start report and the failed step, and exits 1", async () => {
  const result = await scripted({
    statuses: [
      waitingOld,
      "down",
      {
        ...old,
        serviceStartedAt: fresh.serviceStartedAt,
        restart: null,
        workflows: ["develop", "nightly"],
        queue: { workflowId: "develop", lanes: 4 },
        restartFailure: {
          commandId: "restart-report",
          requestedAt,
          code: "restart-update-failed",
          step: "build",
          output: "error TS2322: broken",
        },
      },
    ],
    invocation: { update: true },
  });
  assert.equal(result.code, 1);
  assert.match(result.out, /Restarted: commit 1{40} -> 1{40}/);
  assert.equal(
    result.error,
    [
      "Command ID: restart-report",
      `restart-update-failed: The update stopped at step build. The checkout went back, and the service restarted on commit ${old.serviceCommit}.`,
      "    error TS2322: broken",
      "",
    ].join("\n"),
  );
});

await test("CLV-320 skipped update after the restart prints the local changes and exits 0", async () => {
  const result = await scripted({
    statuses: [
      waitingOld,
      {
        ...fresh,
        restart: null,
        workflows: ["develop", "nightly"],
        queue: { workflowId: "develop", lanes: 4 },
        restartFailure: {
          commandId: "restart-report",
          requestedAt,
          code: "restart-update-skipped",
          step: "clean",
          output: "?? notes.txt",
        },
      },
    ],
    invocation: { update: true },
  });
  assert.equal(result.code, 0, result.error);
  assert.match(
    result.out,
    /\nUpdate skipped: the checkout has local changes\.\n {4}\?\? notes\.txt\n/,
  );
});

await test("CLV-320 a start that gives no status answer within the limit fails, and the limit waits while the restart holds its claim", async () => {
  const silent = await scripted({ statuses: [waitingOld, "down"] });
  assert.equal(silent.code, 1);
  assert.match(silent.error, /^restart-start-unanswered: /m);
  const held = await scripted({
    statuses: [
      waitingOld,
      ...Array<Answer>(12).fill("down"),
      { ...fresh, restart: null, workflows: ["develop", "nightly"] },
    ],
    claimed: { removedAfter: 12, hostProcessId: process.pid },
  });
  assert.equal(held.code, 0, held.error);
});

await test("CLV-320 a claim of a start program that no longer runs does not hold the start limit", async () => {
  const ended = spawnSync(process.execPath, ["--eval", ""]).pid;
  const abandoned = await scripted({
    statuses: [waitingOld, "down"],
    claimed: { removedAfter: 40, hostProcessId: ended },
  });
  assert.equal(abandoned.code, 1);
  assert.match(abandoned.error, /^restart-start-unanswered: /m);
  const polls = abandoned.requests.filter(
    (request) => request["operation"] === "status",
  );
  assert.ok(polls.length < 12, `${String(polls.length)} status requests`);
});

await test("CLV-320 cloving restart takes --within as seconds, minutes or hours and refuses other values", () => {
  const within = (value: string): unknown =>
    record(parseInvocation(["restart", "--within", value]))?.["within"];
  assert.equal(within("30m"), 1800);
  assert.equal(within("6h"), 21_600);
  assert.equal(within("1s"), 1);
  assert.equal(record(parseInvocation(["restart"]))?.["within"], null);
  for (const value of ["0m", "5x", "1.5h", "h", "721h"])
    assert.equal(
      record(parseInvocation(["restart", "--within", value]))?.["code"],
      "invalid-option-value",
      value,
    );
  assert.equal(
    record(parseInvocation(["restart", "--cancel", "--within", "1h"]))?.[
      "code"
    ],
    "unexpected-option",
  );
});
