import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RestartInvocation } from "../src/cli/restart-arguments.ts";
import { restartCommand } from "../src/cli/restart-command.ts";
import { socketAddress } from "../src/broker/socket-address.ts";
import { parseRequest, replyLine, type Fields } from "../src/protocol.ts";

export const old = {
  serviceCommit: "1111111111111111111111111111111111111111",
  serviceStartedAt: "2026-11-06T10:00:00.000Z",
};
export const fresh = {
  serviceCommit: "2222222222222222222222222222222222222222",
  serviceStartedAt: "2026-11-06T10:05:00.000Z",
};
export const requestedAt = 1_793_000_000_000;
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

export type Answer = Fields | "down";

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

export async function scripted(scene: Scene): Promise<{
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
        set: {},
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

export const waitingOld = { ...old, restart: pending.restart };
