import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Fields, Reply } from "../src/protocol.ts";
import type { Permit } from "../src/cli/workspace-permit.ts";
import type { WorkspaceHold } from "../src/queue-room.ts";
import { runIdentity } from "../src/service/submission-handler.ts";
import type { Handle } from "../src/service/transport.ts";
import { eventually } from "./service-fixture.ts";
import { withQueue } from "./issue-queue-fixture.ts";

const reply = (fields: Fields): Promise<Reply> =>
  Promise.resolve({ kind: "result", result: fields });

function admittingService(state: {
  readonly runs: Map<string, Fields>;
  readonly events: string[];
}): Handle {
  return (request) => {
    if (Array.isArray(request.parameters["runIds"]))
      return reply({ runs: [...state.runs.values()] });
    const runId = request.parameters["runId"];
    if (request.operation === "status" && typeof runId === "string")
      return reply({ run: state.runs.get(runId) });
    if (request.operation === "status")
      return reply({ runs: [...state.runs.values()], next: null });
    const id = runIdentity(String(request.parameters["commandId"]));
    state.events.push("submitted");
    state.runs.set(id, { runId: id, workflowId: "develop", state: "running" });
    return reply({ kind: "run-admitted" });
  };
}

const lanesHold: WorkspaceHold = {
  reason: "workspace-lanes",
  busy: 2,
  limit: 2,
  text: "Held: 2 of 2 workspace lanes busy",
};

await test("CLV-312 a workspace hold of the supervisor holds the queue run, shows the hold and keeps no hold period", async () => {
  const state = { runs: new Map<string, Fields>(), events: [] };
  let asked = 0;
  await withQueue(
    {
      handle: admittingService(state),
      permit: () => {
        asked += 1;
        return Promise.resolve({ kind: "held", hold: lanesHold });
      },
    },
    async (scene) => {
      assert.deepEqual(
        await eventually(() => scene.control()?.hold),
        lanesHold,
      );
      await eventually(() => (asked >= 3 ? asked : undefined));
      assert.equal(state.runs.size, 0);
      const holds: unknown = JSON.parse(
        await readFile(join(scene.directory, "queue-holds.json"), "utf8"),
      );
      assert.equal(Reflect.get(Object(holds), "open"), null);
    },
  );
});

function switchedPermit(state: {
  readonly held: boolean;
  readonly events: string[];
}): Promise<Permit> {
  if (state.held) return Promise.resolve({ kind: "held", hold: lanesHold });
  state.events.push("permitted");
  return Promise.resolve({
    kind: "admitted",
    release: () => {
      state.events.push("released");
    },
  });
}

await test("CLV-312 a queue submits its run only with a workspace permit and releases the permit after the submission", async () => {
  const state = {
    runs: new Map<string, Fields>(),
    events: [] as string[],
    held: true,
  };
  await withQueue(
    { handle: admittingService(state), permit: () => switchedPermit(state) },
    async (scene) => {
      await eventually(() => scene.control()?.hold);
      await delay(30);
      assert.equal(state.runs.size, 0);
      state.held = false;
      await eventually(() => (state.runs.size === 1 ? true : undefined));
      await eventually(() =>
        state.events.includes("released") ? true : undefined,
      );
      assert.deepEqual(state.events.slice(0, 3), [
        "permitted",
        "submitted",
        "released",
      ]);
      assert.equal(scene.control()?.hold, undefined);
    },
  );
});
