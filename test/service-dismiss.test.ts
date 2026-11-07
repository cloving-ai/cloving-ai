import assert from "node:assert/strict";
import { after, test } from "node:test";
import { record } from "../src/protocol.ts";
import { dismissRun } from "../src/service/dismiss-handler.ts";
import { workflowRegistry } from "../src/service/registry.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  call,
  fakeRegistration,
  field,
  fields,
  items,
} from "./service-fixture.ts";
import { withQueueSpend } from "./queue-spend-fixture.ts";

after(removeTemporaryDirectories);

type Scene = Parameters<Parameters<typeof withQueueSpend>[0]>[0];

function dismissal(scene: Scene, target: { runId: string; commandId: string }) {
  return call(scene.harness, { operation: "dismiss-run", parameters: target });
}

async function failedRun(scene: Scene, name: string): Promise<string> {
  const runId = await scene.begin(name);
  const shown = await call(scene.harness, {
    operation: "status",
    parameters: { runId },
  });
  const failed = await scene.worker().submit({
    kind: "fail-run",
    commandId: `${name}-fail`,
    runId,
    expectedRevision: Number(record(shown["run"])?.["revision"]),
  });
  assert.equal(failed.kind, "accepted");
  return runId;
}

await test("CLV-321 a dismissal is a recorded command with the run ID that stays in the events after a restart", () =>
  withQueueSpend(
    async (scene) => {
      const runId = await failedRun(scene, "stopped");
      const dismissed = await dismissal(scene, {
        runId,
        commandId: "dismiss-stopped",
      });
      assert.deepEqual(
        [
          dismissed["kind"],
          dismissed["runId"],
          dismissed["commandId"],
          dismissed["replayed"],
        ],
        ["run-dismissed", runId, "dismiss-stopped", false],
      );
      await scene.restart();
      const events = await call(scene.harness, {
        operation: "events",
        parameters: { runId, after: 0, limit: 100 },
      });
      assert.deepEqual(
        items(events["events"])
          .map(fields)
          .filter((event) => event["type"] === "run.dismissed")
          .map((event) => [event["runId"], event["commandId"]]),
        [[runId, "dismiss-stopped"]],
      );
      const again = await dismissal(scene, {
        runId,
        commandId: "dismiss-stopped",
      });
      assert.equal(again["replayed"], true);
    },
    { limitUsd: 1000 },
  ));

await test("CLV-321 cloving dismiss records the same command, and the service refuses an active or unknown run", () =>
  withQueueSpend(
    async (scene) => {
      const active = await scene.begin("active");
      const refused = await dismissal(scene, {
        runId: active,
        commandId: "dismiss-active",
      });
      assert.equal(refused["code"], "run-active");
      const unknown = await dismissal(scene, {
        runId: "absent",
        commandId: "dismiss-unknown",
      });
      assert.equal(unknown["code"], "unknown-run");
      const runId = await failedRun(scene, "stopped");
      const typed = await scene.harness.cli([
        "dismiss",
        runId,
        "--command-id",
        "dismiss-cli",
        "--json",
      ]);
      assert.equal(typed.status, 0, typed.stderr);
      const reply = fields(JSON.parse(typed.stdout));
      assert.deepEqual(
        [reply["kind"], reply["runId"], reply["commandId"]],
        ["run-dismissed", runId, "dismiss-cli"],
      );
    },
    { limitUsd: 1000 },
  ));

await test("CLV-321 a dismiss request that is not valid, or that leaves no receipt, is not reported as a dismissal", async () => {
  const authority = await openedAuthority(await temporaryDirectory());
  const context = {
    authority,
    registry: workflowRegistry([fakeRegistration([])]),
    clock: (): string => "2026-10-10T12:00:00.000Z",
    livenessMilliseconds: 1,
    followMilliseconds: 1,
    resolverMilliseconds: 1000,
    textBytes: 1000,
    documentBytes: 1000,
    gateway: {
      execute: () =>
        Promise.resolve({
          kind: "accepted" as const,
          sequence: 1,
          intents: [],
        }),
    },
  };
  try {
    const invalid = await dismissRun(context, {
      runId: "bad id",
      commandId: "c-1",
    });
    assert.equal(field(field(invalid, "error"), "code"), "invalid-request");
    const lost = await dismissRun(context, {
      runId: "run-1",
      commandId: "c-1",
    });
    assert.deepEqual(lost, {
      kind: "error",
      error: {
        commandId: "c-1",
        runId: "run-1",
        code: "authority-unavailable",
        detail: "authority-unavailable",
      },
    });
  } finally {
    await authority.close();
  }
});
