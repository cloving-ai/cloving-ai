import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { RunStatus } from "../src/authority/transitions.ts";
import type { Authority, StoredState } from "../src/broker/actor/authority.ts";
import type { Fields } from "../src/protocol.ts";
import { status } from "../src/service/run-handlers.ts";
import {
  executeStored,
  opened,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  field,
  items,
  parsed,
  startedRun,
  withHarness,
} from "./service-fixture.ts";
import { statusContext } from "./service-views.ts";

after(removeTemporaryDirectories);

const finishedStates = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

function counted<Group extends object>(
  group: Group,
  counter: { readonly label: string; readonly calls: string[] },
): Group {
  return new Proxy(group, {
    get(target, name): unknown {
      const value: unknown = Reflect.get(target, name);
      if (typeof value !== "function") return value;
      return (...values: unknown[]): unknown => {
        counter.calls.push(
          `${counter.label}.${String(name)} ${JSON.stringify(values)}`,
        );
        return Reflect.apply(value, target, values);
      };
    },
  });
}

function withFinishedRuns(state: StoredState, count: number): StoredState {
  const started = state.runs["run-1"];
  assert.ok(started);
  const runs = [
    ...Array.from({ length: count }, (_, index) => ({
      ...started,
      runId: `ended-${String(index).padStart(3, "0")}`,
      status: finishedStates[index % 3] ?? "completed",
    })),
    { ...started, runId: "run-2", status: "queued" as const },
    { ...started, runId: "run-3", status: "running" as const },
  ];
  return {
    ...state,
    runs: {
      ...state.runs,
      ...Object.fromEntries(runs.map((run) => [run.runId, run])),
    },
  };
}

async function listedQueries(
  store: Authority,
  listing: { readonly finished: number; readonly parameters: Fields },
) {
  const calls: string[] = [];
  const state = withFinishedRuns(await store.state(), listing.finished);
  const authority = counted(
    {
      ...store,
      state: () => Promise.resolve(state),
      queries: counted(store.queries, { label: "queries", calls }),
      effects: counted(store.effects, { label: "effects", calls }),
    },
    { label: "authority", calls },
  );
  const reply = await status(statusContext(authority), listing.parameters);
  const result = field(reply, "result");
  return {
    calls,
    reply,
    result,
    runIds: items(field(result, "runs")).map((run) => field(run, "runId")),
  };
}

async function withStartedStore(read: (store: Authority) => Promise<void>) {
  const { store } = await opened(await temporaryDirectory());
  try {
    for (const command of storedGate.slice(0, 2))
      await executeStored(store, command);
    await read(store);
  } finally {
    await store.close();
  }
}

await test("CLV-275 active status builds no view of a finished run", () =>
  withStartedStore(async (store) => {
    const every = await listedQueries(store, {
      finished: 500,
      parameters: {},
    });
    assert.ok(every.calls.some((call) => call.includes('"ended-000"')));
    const active = await listedQueries(store, {
      finished: 500,
      parameters: { active: true },
    });
    assert.deepEqual(active.runIds, ["run-1", "run-2", "run-3"]);
    assert.equal(field(active.result, "next"), null);
    assert.deepEqual(
      active.calls.filter((call) => call.includes("ended-")),
      [],
    );
  }));

await test("CLV-275 active status runs the same queries with 500 finished runs as with none", () =>
  withStartedStore(async (store) => {
    const none = await listedQueries(store, {
      finished: 0,
      parameters: { active: true },
    });
    const many = await listedQueries(store, {
      finished: 500,
      parameters: { active: true },
    });
    assert.ok(none.calls.length > 0);
    assert.deepEqual(many.calls, none.calls);
    assert.deepEqual(many.result, none.result);
  }));

await test("CLV-275 active status pages with limit and after and refuses a malformed selection", () =>
  withStartedStore(async (store) => {
    const first = await listedQueries(store, {
      finished: 500,
      parameters: { active: true, limit: 2 },
    });
    assert.deepEqual(first.runIds, ["run-1", "run-2"]);
    assert.equal(field(first.result, "next"), "run-2");
    const second = await listedQueries(store, {
      finished: 500,
      parameters: { active: true, limit: 2, after: "run-2" },
    });
    assert.deepEqual(second.runIds, ["run-3"]);
    assert.equal(field(second.result, "next"), null);
    const malformed = await listedQueries(store, {
      finished: 0,
      parameters: { active: "yes" },
    });
    assert.equal(
      field(field(malformed.reply, "error"), "code"),
      "invalid-request",
    );
  }));

await test("CLV-275 cloving status --active --json lists only active runs with the fields of the default list", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    try {
      const finished = await startedRun(harness, {
        service,
        commandId: "finished",
      });
      const running = await startedRun(harness, {
        service,
        commandId: "running",
      });
      const completion = await service.worker.submit({
        kind: "complete-run",
        commandId: "finished-end",
        runId: finished,
        expectedRevision: 2,
      });
      assert.equal(completion.kind, "accepted");
      const every = await harness.cli(["status", "--json"]);
      const active = await harness.cli(["status", "--active", "--json"]);
      assert.equal(active.status, 0, active.stderr);
      const listed = parsed(every);
      assert.deepEqual(
        items(listed["runs"]).map((run) => field(run, "runId")),
        [finished, running].sort(),
      );
      assert.deepEqual(parsed(active), {
        ...listed,
        runs: items(listed["runs"]).filter(
          (run) => field(run, "runId") === running,
        ),
      });
    } finally {
      await service.close();
    }
  }));
