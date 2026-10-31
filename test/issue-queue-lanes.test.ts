import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Fields, Reply } from "../src/protocol.ts";
import { runIdentity } from "../src/service/submission-handler.ts";
import { eventually } from "./service-fixture.ts";
import type { Handle } from "../src/service/transport.ts";
import { withQueue } from "./issue-queue-fixture.ts";

const reply = (fields: Fields): Promise<Reply> =>
  Promise.resolve({ kind: "result", result: fields });
const empty: Reply = {
  kind: "error",
  error: { code: "no-ready-ticket", detail: "empty" },
};

function laneService(state: {
  runs: Map<string, Fields>;
  admissions: number[];
  scans: number;
}): Handle {
  return (request) => {
    if (Array.isArray(request.parameters["runIds"]))
      return reply({ runs: [...state.runs.values()] });
    const runId = request.parameters["runId"];
    if (request.operation === "status" && typeof runId === "string")
      return reply({ run: state.runs.get(runId) });
    if (request.operation === "status") {
      state.scans += 1;
      return reply({ runs: [...state.runs.values()], next: null });
    }
    state.admissions.push(state.scans);
    const id = runIdentity(String(request.parameters["commandId"]));
    state.runs.set(id, {
      runId: id,
      workflowId: "develop",
      state: "running",
    });
    return reply({ kind: "run-admitted" });
  };
}

function completionService(state: {
  readonly runs: ReadonlyMap<string, Fields>;
  admissions: number;
}): Handle {
  return (request) => {
    if (request.operation === "run") {
      state.admissions += 1;
      return Promise.resolve(empty);
    }
    if (Array.isArray(request.parameters["runIds"]))
      return reply({
        runs: [...state.runs].map(([runId, run]) => ({ ...run, runId })),
      });
    return reply({
      run: state.runs.get(String(request.parameters["runId"])),
      runs: [],
      next: null,
    });
  };
}

function holdService(state: {
  ended: boolean;
  admissions: number;
  readonly commands: readonly string[];
}): Handle {
  return (request) => {
    if (request.operation === "run") {
      state.admissions += 1;
      return Promise.resolve(empty);
    }
    if (Array.isArray(request.parameters["runIds"]))
      return reply({
        runs: state.commands.map((command) => ({
          runId: runIdentity(command),
          state: state.ended ? "completed" : "running",
          outcome: { kind: "handoff_requested" },
        })),
      });
    const run = {
      state: state.ended ? "completed" : "running",
      outcome: { kind: "handoff_requested" },
    };
    return reply({
      run,
      runs: state.ended
        ? []
        : state.commands.map(() => ({ ...run, workflowId: "develop" })),
      next: null,
    });
  };
}

await test("CLV-184 a stand-in service admits one ticket each cycle up to the lane limit", async () => {
  for (const lanes of [1, 4]) {
    const state = {
      runs: new Map<string, Fields>(),
      admissions: Array<number>(),
      scans: 0,
    };
    await withQueue({ lanes, handle: laneService(state) }, async (scene) => {
      await eventually(() => (state.runs.size === lanes ? true : undefined));
      await delay(40);
      await scene.stop();
      assert.equal(state.runs.size, lanes);
      assert.equal(new Set(state.admissions).size, lanes);
    });
  }
});

await test("CLV-184 simultaneous completions count failures in finish order", async () => {
  const commands = ["first", "second", "third", "fourth"];
  const sequences = [4, 3, 1, 2];
  const runs = new Map(
    commands.map((command, index) => [
      runIdentity(command),
      {
        state: "completed",
        latestSequence: sequences[index],
        outcome: {
          kind: command === "third" ? "handoff_requested" : "blocked",
        },
      },
    ]),
  );
  const state = { runs, admissions: 0 };
  await withQueue(
    { lanes: 4, commands, handle: completionService(state) },
    async (scene) => {
      await eventually(async () =>
        (await scene.commands()).length === 0 ? true : undefined,
      );
      await scene.stop();
      const saved: unknown = JSON.parse(
        await readFile(join(scene.directory, "queue-commands.json"), "utf8"),
      );
      assert.deepEqual(saved, {
        commands: [],
        failures: ["fourth", "second", "first"].map(runIdentity),
      });
      assert.equal(state.admissions, 0);
    },
  );
});

await test("CLV-184 self-update holds new admissions while all active lanes drain", async () => {
  const commands = ["one", "two", "three"];
  const state = { commands, ended: false, admissions: 0 };
  const admissions = (): number => state.admissions;
  await withQueue(
    {
      lanes: 4,
      commands,
      intervalMilliseconds: 30,
      handle: holdService(state),
    },
    async (scene) => {
      const hold = join(scene.directory, "pending-self-update");
      await writeFile(hold, String(Date.now()));
      await delay(100);
      assert.equal(admissions(), 0);
      state.ended = true;
      await eventually(async () =>
        (await scene.commands()).length === 0 ? true : undefined,
      );
      assert.equal(admissions(), 0);
      await rm(hold);
      await eventually(() => (admissions() > 0 ? true : undefined));
      await scene.stop();
      assert.ok(admissions() > 0);
    },
  );
});

await test("CLV-184 a self-update still holds draining lanes after the stale-marker timeout", async () => {
  const commands = ["one", "two"];
  const state = { commands, ended: false, admissions: 0 };
  const admissions = (): number => state.admissions;
  await withQueue(
    {
      lanes: 2,
      commands,
      handle: holdService(state),
      selfUpdateHold: {
        mark: String(Date.now()),
        startedAt: Date.now() - 31 * 60 * 1000,
      },
    },
    async (scene) => {
      await delay(80);
      assert.equal(admissions(), 0);
      state.ended = true;
      await eventually(async () =>
        (await scene.commands()).length === 0 ? true : undefined,
      );
      await delay(80);
      assert.equal(admissions(), 0);
      await rm(join(scene.directory, "pending-self-update"));
      await eventually(() => (admissions() > 0 ? true : undefined));
      await scene.stop();
      assert.ok(admissions() > 0);
    },
  );
});

function racingCompletions(state: { reads: number; batches: number }): Handle {
  const success = {
    runId: runIdentity("one"),
    state: "completed",
    latestSequence: 99,
    terminalSequence: 10,
    outcome: { kind: "handoff_requested" },
  };
  const failure = {
    runId: runIdentity("two"),
    state: "completed",
    latestSequence: 11,
    terminalSequence: 11,
    outcome: { kind: "blocked" },
  };
  return (request) => {
    if (Array.isArray(request.parameters["runIds"])) {
      state.batches += 1;
      return reply({ runs: [success, failure] });
    }
    if (typeof request.parameters["runId"] === "string") {
      state.reads += 1;
      return reply({
        run:
          request.parameters["runId"] === success.runId
            ? { ...success, state: "running" }
            : failure,
      });
    }
    return reply({
      runs: Array.from({ length: 4 }, () => ({
        workflowId: "develop",
        state: "running",
      })),
      next: null,
    });
  };
}

await test("CLV-184 an earlier handoff between status reads clears prior failures before a later failure", async () => {
  const state = { reads: 0, batches: 0 };
  await withQueue(
    {
      lanes: 4,
      commands: ["one", "two"],
      failures: ["old-one", "old-two"],
      handle: racingCompletions(state),
    },
    async (scene) => {
      await eventually(() =>
        state.reads >= 4 || state.batches > 0 ? true : undefined,
      );
      await scene.stop();
      const saved: unknown = JSON.parse(
        await readFile(join(scene.directory, "queue-commands.json"), "utf8"),
      );
      assert.deepEqual(saved, { commands: [], failures: [runIdentity("two")] });
    },
  );
});
