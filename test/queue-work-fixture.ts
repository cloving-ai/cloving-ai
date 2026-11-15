import assert from "node:assert/strict";
import { githubIntent, type GithubScene } from "./github-worker-fixture.ts";
import type { GithubWorker } from "../src/daemon/github-worker.ts";
import { createHash } from "node:crypto";
import type {
  Authority,
  OperationView,
} from "../src/broker/actor/authority.ts";
import { documentDigest } from "../src/broker/decision-restore.ts";
import { effectInputDigest } from "../src/broker/effect-restore.ts";
import { pinnedIdentity } from "../src/execution-pin.ts";
import { manifest, storedGate } from "./authority-store-fixture.ts";
import { effectRequest, noon } from "./effect-fixture.ts";
import type { OperationWork } from "../src/service/worker-port.ts";

export function stagePort(authority: Authority) {
  return (stage: OperationWork) => {
    const { action, ...fields } = stage;
    return authority.execute(
      { kind: `${action}-operation-work`, ...fields },
      { recordedAt: noon, epoch: authority.epoch, documents: [] },
    );
  };
}

export async function start(
  authority: Authority,
  run: { readonly runId: string; readonly kind?: string },
) {
  const { runId, kind = "queue" } = run;
  const pinned = {
    ...manifest,
    capabilities: ["fake-harness", "github"],
    ...(kind === "queue" ? { queue: true } : {}),
  };
  const submission = JSON.stringify({
    workflowId: kind === "other" ? "scheduled" : "develop-issue",
  });
  const input = "{}";
  const context = {
    recordedAt: noon,
    epoch: authority.epoch,
    documents: [submission, input],
  };
  const workflow = `sha256:${createHash("sha256").update(pinnedIdentity(pinned)).digest("hex")}`;
  const admitted = await authority.execute(
    {
      ...storedGate[0],
      runId,
      commandId: `admit-${runId}`,
      workflow,
      effectLimit: 1,
      capabilities: JSON.stringify(pinned.capabilities),
      submission: documentDigest(submission),
      input: documentDigest(input),
      resolver: kind === "manual" ? "custom:1" : "issue-command:1",
    },
    { ...context, manifest: pinned },
  );
  assert.equal(admitted.kind, "accepted", JSON.stringify(admitted));
  assert.equal(
    (
      await authority.execute(
        {
          kind: "mark-started",
          runId,
          commandId: `start-${runId}`,
          expectedRevision: 1,
        },
        context,
      )
    ).kind,
    "accepted",
  );
}

export async function request(
  authority: Authority,
  run: {
    readonly runId: string;
    readonly capability?: "github";
    readonly payload?: string;
  },
) {
  const { runId } = run;
  const github = run.capability === "github";
  const effect = effectRequest({
    commandId: `request-${runId}`,
    round: 1,
    runId,
    ...(run.payload === undefined ? {} : { payload: run.payload }),
  });
  const command: Readonly<Record<string, unknown>> = {
    ...effect.command,
    ...(github
      ? { capability: "github", method: "merge", target: "ticket/one" }
      : {}),
  };
  const receipt = await authority.execute(
    {
      ...command,
      inputDigest: effectInputDigest({
        capability: String(command["capability"]),
        method: String(command["method"]),
        target: String(command["target"]),
        payload: String(command["payload"]),
      }),
    },
    { recordedAt: noon, epoch: authority.epoch, documents: effect.documents },
  );
  assert.equal(receipt.kind, "accepted", JSON.stringify(receipt));
  const operation = (await authority.effects.operations(runId))[0];
  assert.ok(operation);
  return operation;
}

export async function work(
  authority: Authority,
  stage: {
    readonly runId: string;
    readonly action: "enter" | "leave";
    readonly id: string;
    readonly generation?: number;
    readonly stageId?: string;
  },
) {
  const { runId, action, id, generation = 1 } = stage;
  const operation = (await authority.effects.operations(runId))[0];
  assert.ok(operation);
  const previous = (await authority.events()).findLast(
    (event) =>
      event.type === "operation.work-entered" &&
      event.payload["operationId"] === operation.operationId,
  );
  const stageId =
    stage.stageId ??
    (action === "enter" ? id : (previous?.payload["stageId"] ?? id));
  return authority.execute(
    {
      kind: `${action}-operation-work`,
      stageId,
      commandId: id,
      runId,
      operationId: operation.operationId,
      inputDigest: operation.inputDigest,
      leaseGeneration: generation,
    },
    { recordedAt: noon, epoch: authority.epoch, documents: [] },
  );
}

export function mergeWorker(
  scene: GithubScene,
  check: {
    readonly authority: Authority;
    readonly operation: OperationView;
    readonly commit: string;
    readonly marker: string;
    readonly release: string;
    readonly stages: string[];
    readonly onAttempt: () => void;
  },
) {
  const { authority, operation, commit, marker, release, stages } = check;
  return scene.worker({
    document: () => Promise.resolve(JSON.stringify({ number: 1, commit })),
    check: [
      process.execPath,
      "-e",
      `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, 'started'); const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(t)},10)`,
    ],
    work: async (stage) => {
      const { action, ...identity } = stage;
      assert.equal(identity.operationId, operation.operationId);
      const receipt = await authority.execute(
        { kind: `${action}-operation-work`, ...identity },
        { recordedAt: noon, epoch: authority.epoch, documents: [] },
      );
      stages.push(`${action}:${receipt.kind}`);
      check.onAttempt();
      return receipt;
    },
  });
}

export async function move(
  authority: Authority,
  change: { readonly runId: string; readonly action: "pause" | "resume" },
) {
  const { runId, action } = change;
  const revision = (await authority.state()).runs[runId]?.revision;
  const manifest = await authority.queries.manifest(runId);
  assert.ok(manifest);
  return authority.execute(
    {
      kind: `${action}-run`,
      runId,
      commandId: `${action}-${runId}`,
      expectedRevision: revision,
    },
    {
      recordedAt: noon,
      epoch: authority.epoch,
      documents: [],
      ...(action === "resume" ? { manifest } : {}),
    },
  );
}

export function deliverMerge(worker: GithubWorker, operation: OperationView) {
  return worker.deliver(
    githubIntent({
      runId: operation.runId,
      operationId: operation.operationId,
      inputDigest: operation.inputDigest,
      method: "merge",
      target: operation.target,
      payload: operation.payload,
    }),
    new AbortController().signal,
  );
}
