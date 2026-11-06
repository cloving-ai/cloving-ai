import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Fields, Reply } from "../src/protocol.ts";
import { runIdentity } from "../src/service/submission-handler.ts";
import type { Handle } from "../src/service/transport.ts";
import type { HostSignals, RoomLimits } from "../src/queue-room.ts";
import { eventually } from "./service-fixture.ts";
import { withQueue } from "./issue-queue-fixture.ts";

const reply = (fields: Fields): Promise<Reply> =>
  Promise.resolve({ kind: "result", result: fields });

function admittingService(state: {
  readonly runs: Map<string, Fields>;
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
    state.runs.set(id, { runId: id, workflowId: "develop", state: "running" });
    return reply({ kind: "run-admitted" });
  };
}

const defaults: RoomLimits = {
  maxLoadPerCore: 0.7,
  maxMemoryPressure: "normal",
};

function room(signals: HostSignals, limits: RoomLimits = defaults) {
  return {
    limits: () => limits,
    signals: () => Promise.resolve(signals),
  };
}

await test("CLV-309 a load above the limit holds the run and gives the hold reason", async () => {
  const state = { runs: new Map<string, Fields>() };
  await withQueue(
    {
      handle: admittingService(state),
      room: room({ loadAverage: 10.8, cores: 12, memoryPressure: "normal" }),
    },
    async (scene) => {
      const hold = await eventually(() => scene.control()?.hold);
      await delay(40);
      assert.equal(state.runs.size, 0);
      assert.deepEqual(hold, {
        reason: "load",
        loadPerCore: 0.9,
        limit: 0.7,
        text: "Held: load 0.90 for each core, limit 0.70",
      });
    },
  );
});

await test("CLV-309 a memory pressure above the limit holds the run", async () => {
  const state = { runs: new Map<string, Fields>() };
  await withQueue(
    {
      handle: admittingService(state),
      room: room({ loadAverage: 1, cores: 12, memoryPressure: "warn" }),
    },
    async (scene) => {
      const hold = await eventually(() => scene.control()?.hold);
      await delay(40);
      assert.equal(state.runs.size, 0);
      assert.deepEqual(hold, {
        reason: "memory",
        pressure: "warn",
        limit: "normal",
        text: "Held: memory pressure warn, limit normal",
      });
    },
  );
});

await test("CLV-309 a machine with room starts the next run and clears the hold", async () => {
  const state = { runs: new Map<string, Fields>() };
  const signals: { current: HostSignals } = {
    current: { loadAverage: 12, cores: 12, memoryPressure: "normal" },
  };
  await withQueue(
    {
      handle: admittingService(state),
      room: {
        limits: () => defaults,
        signals: () => Promise.resolve(signals.current),
      },
    },
    async (scene) => {
      await eventually(() => scene.control()?.hold);
      signals.current = {
        loadAverage: 3.6,
        cores: 12,
        memoryPressure: "normal",
      };
      await eventually(() => (state.runs.size === 1 ? true : undefined));
      await eventually(() =>
        scene.control()?.hold === undefined ? true : undefined,
      );
    },
  );
});

await test("CLV-309 the warn setting admits a run at the warn memory pressure", async () => {
  const state = { runs: new Map<string, Fields>() };
  await withQueue(
    {
      handle: admittingService(state),
      room: room(
        { loadAverage: 1, cores: 12, memoryPressure: "warn" },
        { maxLoadPerCore: 0.7, maxMemoryPressure: "warn" },
      ),
    },
    async () => {
      await eventually(() => (state.runs.size === 1 ? true : undefined));
    },
  );
});

async function opened(
  folder: string,
  entry: { readonly key: string; readonly runId: string },
): Promise<void> {
  await mkdir(join(folder, entry.key), { recursive: true });
  await writeFile(
    join(folder, entry.key, "started.json"),
    JSON.stringify({ runId: entry.runId, operationId: "operation" }),
  );
}

function workingService(state: {
  readonly runs: Map<string, Fields>;
  admissions: number;
}): Handle {
  return (request) => {
    const listed = [...state.runs.values()];
    if (request.operation === "run") {
      state.admissions += 1;
      const id = runIdentity(String(request.parameters["commandId"]));
      state.runs.set(id, {
        runId: id,
        workflowId: "develop",
        state: "running",
      });
      return reply({ kind: "run-admitted" });
    }
    if (request.parameters["active"] === true)
      return reply({ runs: listed, next: null });
    const busy = listed.filter((run) => run["workflowId"] === "develop");
    return reply({ queue: { busy: busy.length }, runs: [], next: null });
  };
}

async function busyRuns(
  directory: string,
  runs: Map<string, Fields>,
): Promise<void> {
  for (const runId of ["one", "two", "three"])
    await opened(join(directory, "journal"), { key: runId, runId });
  await opened(join(directory, "commands"), {
    key: "four-check",
    runId: "four",
  });
  await opened(join(directory, "github"), {
    key: "four-ci",
    runId: "four",
  });
  await opened(join(directory, "github"), {
    key: "five-ci",
    runId: "five",
  });
  runs.set("six", {
    runId: "six",
    workflowId: "other",
    state: "running",
    pendingDecisions: ["question"],
  });
}

await test("CLV-309 working lanes hold a new run until a working run begins to wait for CI", async () => {
  const runs = new Map<string, Fields>(
    ["one", "two", "three", "four", "five"].map((runId) => [
      runId,
      { runId, workflowId: "develop", state: "running" },
    ]),
  );
  const state = { runs, admissions: 0 };
  await withQueue(
    {
      handle: workingService(state),
      lanes: 6,
      workingLanes: 3,
      room: room({ loadAverage: 0, cores: 12, memoryPressure: "normal" }),
    },
    async (scene) => {
      await busyRuns(scene.directory, runs);
      const hold = await eventually(() => scene.control()?.hold);
      assert.deepEqual(hold, {
        reason: "working-lanes",
        working: 4,
        limit: 3,
        text: "Held: 4 of 3 working lanes busy",
      });
      await rm(join(scene.directory, "commands/four-check"), {
        recursive: true,
      });
      const working = await eventually(() =>
        scene.control()?.hold?.reason === "working-lanes" &&
        scene.control()?.hold?.text === "Held: 3 of 3 working lanes busy"
          ? true
          : undefined,
      );
      assert.equal(working, true);
      assert.equal(state.admissions, 0);
      runs.set("three", {
        runId: "three",
        workflowId: "develop",
        state: "running",
        pendingDecisions: ["question"],
      });
      await rm(join(scene.directory, "journal/three"), { recursive: true });
      await eventually(() => (state.admissions === 1 ? true : undefined));
    },
  );
});

await test("CLV-309 a drain clears the hold of a held queue", async () => {
  const state = { runs: new Map<string, Fields>() };
  await withQueue(
    {
      handle: admittingService(state),
      room: room({ loadAverage: 12, cores: 12, memoryPressure: "normal" }),
    },
    async (scene) => {
      await eventually(() => scene.control()?.hold);
      const drained = await scene.change({
        command: "drain",
        commandId: "drain-held",
      });
      assert.equal(drained.kind, "changed");
      await eventually(() =>
        scene.control()?.hold === undefined ? true : undefined,
      );
      assert.equal(state.runs.size, 0);
    },
  );
});
