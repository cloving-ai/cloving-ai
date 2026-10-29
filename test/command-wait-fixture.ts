import assert from "node:assert/strict";
import type { ExecutionManifest } from "../src/workflow-admission.ts";
import type { Authority } from "../src/broker/actor/authority.ts";
import { documentDigest } from "../src/broker/decision-restore.ts";
import { workflowPin } from "../src/broker/workflow-pin.ts";
import { admit, recorded } from "./authority-fixture.ts";
import {
  manifest,
  opened,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

export const permission = {
  command: "review-state",
  maximumWaitSeconds: 2_592_000,
  pollEverySeconds: 3_600,
};
export const pinned = {
  ...manifest,
  capabilities: ["command"],
  commands: ["review-state"],
  commandWaits: { "team-review": permission },
};
export const payload = JSON.stringify({ change: 42 });
export const opening = {
  kind: "open-command-wait",
  commandId: "open-review",
  runId: "run-1",
  waitName: "team-review",
  target: permission.command,
  maximumWaitSeconds: permission.maximumWaitSeconds,
  pollEverySeconds: permission.pollEverySeconds,
  payload: documentDigest(payload),
};
export const context = { ...recorded, documents: [payload] };

export async function waitStore(
  declaration: ExecutionManifest = pinned,
): Promise<{
  readonly store: Authority;
  readonly directory: string;
}> {
  const directory = await temporaryDirectory();
  const { store } = await opened(directory);
  await startWaitRun(store, { runId: "run-1", declaration });
  return { store, directory };
}

export async function startWaitRun(
  store: Authority,
  scope: { readonly runId: string; readonly declaration?: ExecutionManifest },
): Promise<void> {
  const { runId } = scope;
  const declaration = scope.declaration ?? pinned;
  for (const [command, evidence] of [
    [
      {
        ...admit,
        runId,
        commandId: `admit-${runId}`,
        workflow: workflowPin(declaration),
        effectLimit: 2,
        capabilities: '["command"]',
      },
      { ...recorded, manifest: declaration },
    ],
    [
      {
        kind: "mark-started",
        commandId: `start-${runId}`,
        runId,
        expectedRevision: 1,
      },
      recorded,
    ],
  ] as const) {
    const result = await store.execute(command, evidence);
    assert.equal(result.kind, "accepted", JSON.stringify(result));
  }
}
