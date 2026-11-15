import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import type {
  Authority,
  OperationView,
} from "../src/broker/actor/authority.ts";
import { record } from "../src/protocol.ts";
import { until } from "./claude-worker-fixture.ts";
import {
  githubIntent,
  opened,
  type GithubScene,
} from "./github-worker-fixture.ts";
import { noon } from "./effect-fixture.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import { temporaryDirectory } from "./authority-store-fixture.ts";
import { start, request } from "./queue-work-fixture.ts";

const workerUrl = new URL("../src/daemon/github-worker.ts", import.meta.url)
  .href;

const script = `
import { readFileSync } from "node:fs";
import { githubWorker } from ${JSON.stringify(workerUrl)};
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pending = new Map();
process.on("message", message => { const settle=pending.get(message.key); if(settle){pending.delete(message.key);settle(message.receipt);} });
const worker = githubWorker({ ...config.settings,
  document: async () => config.payload,
  operationStatus: async id => id === config.intent.operationId ? "running" : undefined,
  runStatus: async () => "running",
  report: async value => { process.send({kind:"report",value}); },
  work: stage => new Promise(resolve => { pending.set(stage.commandId, resolve); process.send({kind:"work",stage}); }),
});
await worker.scan();
if(config.mode === "first") await worker.deliver(config.intent,new AbortController().signal);
process.send({kind:"ready"});
`;

interface WorkerCase {
  readonly authority: Authority;
  readonly operation: OperationView;
  readonly commit: string;
  readonly marker: string;
  readonly release: string;
  readonly mode: "first" | "reopen";
  readonly leaveReply?: "hold";
}

interface RecoveryState {
  ready: boolean;
  report?: unknown;
  error: string;
  readonly work: {
    readonly action: string;
    readonly commandId: string;
    readonly kind: string;
    readonly reason?: string;
  }[];
}

async function received(
  context: {
    readonly authority: Authority;
    readonly child: ChildProcess;
    readonly state: RecoveryState;
    readonly leaveReply: "hold" | undefined;
  },
  message: unknown,
) {
  const value = record(message);
  const stage = record(value?.["stage"]);
  if (value?.["kind"] !== "work" || stage === undefined) return;
  const { action, ...identity } = stage;
  const receipt = await context.authority.execute(
    { kind: `${String(action)}-operation-work`, ...identity },
    { recordedAt: noon, epoch: context.authority.epoch, documents: [] },
  );
  context.state.work.push({
    action: String(action),
    commandId: String(stage["commandId"]),
    kind: receipt.kind,
    ...(receipt.kind === "rejected" ? { reason: receipt.reason } : {}),
  });
  if (context.leaveReply === "hold" && action === "leave") return;
  if (context.child.connected)
    context.child.send({ key: stage["commandId"], receipt }, () => undefined);
}

function configuration(scene: GithubScene, given: WorkerCase) {
  const { operation, commit, marker, release, mode } = given;
  return {
    mode,
    payload: JSON.stringify({ number: 1, commit }),
    intent: githubIntent({
      runId: operation.runId,
      operationId: operation.operationId,
      inputDigest: operation.inputDigest,
      method: "merge",
      target: operation.target,
      payload: operation.payload,
    }),
    settings: {
      repository: scene.repository,
      worktrees: scene.worktrees,
      journal: scene.journal,
      gh: [process.execPath, join(scene.directory, "fake-gh.mjs")],
      environment: {
        FAKE_GH_STATE: join(scene.directory, "gh-state.json"),
        FAKE_GH_ORIGIN: scene.origin,
      },
      timing: {
        pollMilliseconds: 10,
        triggerMilliseconds: 150,
        limitMilliseconds: 600,
        ciGraceMilliseconds: 0,
      },
      check: [
        process.execPath,
        "-e",
        `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'check\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},10)`,
      ],
    },
  };
}

export function recoveryWorker(scene: GithubScene, given: WorkerCase) {
  const source = join(scene.directory, `worker-${randomUUID()}.mjs`);
  const input = `${source}.json`;
  writeFileSync(source, script);
  writeFileSync(input, JSON.stringify(configuration(scene, given)));
  const child = fork(source, [input], {
    cwd: scene.repository,
    detached: true,
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const ended = once(child, "exit");
  const state: RecoveryState = { ready: false, error: "", work: [] };
  child.stderr?.on("data", (value) => {
    state.error += String(value);
  });
  child.on("message", (message: unknown) => {
    const value = record(message);
    if (value?.["kind"] === "ready") state.ready = true;
    if (value?.["kind"] === "report") state.report = value["value"];
    received(
      {
        authority: given.authority,
        child,
        state,
        leaveReply: given.leaveReply,
      },
      message,
    ).catch((error: unknown) => {
      state.error += String(error);
    });
  });
  const kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    await ended;
  };
  return {
    state,
    ready: () => until(() => state.ready),
    kill,
    [Symbol.asyncDispose]: kill,
  };
}

interface RecoveryCase extends Omit<WorkerCase, "mode" | "leaveReply"> {
  readonly limits: {
    capacity: number;
    queueLimit: number;
    queueWorkingLimit: number;
  };
}

export async function withRecovery(
  scene: GithubScene,
  check: (given: RecoveryCase) => Promise<void>,
) {
  const commit = await opened(scene, scene.worker());
  const limits = { capacity: 4, queueLimit: 3, queueWorkingLimit: 1 };
  const authority = await openedAuthority(await temporaryDirectory(), {
    clock: () => noon,
    leaseLimits: () => limits,
  });
  const marker = join(scene.directory, "verify-starts");
  const release = join(scene.directory, "verify-release");
  try {
    await start(authority, { runId: "merge" });
    const payload = JSON.stringify({ number: 1, commit });
    const operation = await request(authority, {
      runId: "merge",
      capability: "github",
      payload,
    });
    assert.equal(await authority.queries.document(operation.payload), payload);
    await check({ authority, operation, commit, marker, release, limits });
  } finally {
    writeFileSync(release, "go");
    await authority.close();
  }
}

export async function completedRecovery(
  worker: ReturnType<typeof recoveryWorker>,
  given: RecoveryCase,
) {
  writeFileSync(given.release, "go");
  await until(() => worker.state.report !== undefined);
  assert.match(JSON.stringify(worker.state.report), /"outcome":"completed"/);
  assert.doesNotMatch(
    JSON.stringify(worker.state.report),
    /github-call-failed|check-failed/,
  );
  assert.equal((await given.authority.effects.budget("merge"))?.spent, 1);
}
