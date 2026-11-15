import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSettings } from "../src/project-settings.ts";
import { reloadedQueueLimits } from "../tools/self-host-queue.ts";
import { queueGlobalLimits } from "../tools/self-host-global-queue.ts";
import type { Service } from "../src/service/service.ts";
import {
  call,
  withHarness,
  digestOf,
  type Harness,
} from "./service-fixture.ts";

await test("CLV-377 global startup validates both bounds and the active-work pair before admission", () => {
  for (const value of ["0", "17", "1.5", "invalid", "9007199254740993"])
    for (const field of [
      "CLOVING_QUEUE_GLOBAL_LANES",
      "CLOVING_QUEUE_GLOBAL_WORKING_LANES",
    ])
      assert.throws(
        () => queueGlobalLimits({ [field]: value }),
        /invalid-global-queue/,
      );
  assert.throws(
    () =>
      queueGlobalLimits({
        CLOVING_QUEUE_GLOBAL_LANES: "2",
        CLOVING_QUEUE_GLOBAL_WORKING_LANES: "3",
      }),
    /invalid-global-queue-working-lanes/,
  );
  assert.deepEqual(
    queueGlobalLimits(
      { CLOVING_QUEUE_GLOBAL_WORKING_LANES: "2" },
      { "queue.globalWorkingLanes": "project" },
    ),
    {
      workingLanes: 2,
      sources: {
        lanes: "default",
        workingLanes: "queue setting (project file)",
      },
    },
  );
  assert.deepEqual(queueGlobalLimits({ CLOVING_QUEUE_GLOBAL_LANES: "16" }), {
    lanes: 16,
    sources: { lanes: "environment", workingLanes: "default" },
  });
});

await test("CLV-377 global capacity is opt-in and leaves the existing lane default intact", () => {
  const old = resolveSettings(
    {},
    { project: undefined, private: '{"version":1,"queue":{"lanes":2}}' },
  );
  assert.equal(old.environment["CLOVING_QUEUE_GLOBAL_LANES"], undefined);
  const configured = resolveSettings(
    { CLOVING_QUEUE_SECONDS: "120" },
    {
      project: undefined,
      private:
        '{"version":1,"queue":{"lanes":2,"globalLanes":5,"globalWorkingLanes":3}}',
    },
  );
  assert.equal(configured.environment["CLOVING_QUEUE_LANES"], "2");
  assert.equal(configured.environment["CLOVING_QUEUE_GLOBAL_LANES"], "5");
  assert.deepEqual(
    reloadedQueueLimits(configured.environment, {
      declarations: [],
      sources: configured.sources,
    }).global,
    {
      lanes: 5,
      workingLanes: 3,
      sources: {
        lanes: "queue setting (private file)",
        workingLanes: "queue setting (private file)",
      },
    },
  );
});

function queued(harness: Harness, workflowId: string) {
  return {
    ...harness.registration,
    workflowId,
    admission: 4,
    manifest: { ...harness.registration.manifest, queue: true },
  };
}

await test("CLV-377 aggregate stopped and off states are not reported as drained", () =>
  withHarness(async (harness) => {
    const state = { name: "stopped" };
    const port = {
      control: () => ({
        failedRunIds: [],
        drain: undefined,
        error: state.name === "stopped" ? "Unavailable disk" : undefined,
        lanes: 4,
        ...(state.name === "off"
          ? { off: { workflowId: "alpha", source: "queues setting" as const } }
          : {}),
      }),
      change: () => Promise.resolve({ kind: "changed" as const }),
    };
    await harness.start({
      workflows: [queued(harness, "alpha"), queued(harness, "beta")],
      queues: new Map([
        ["alpha", port],
        ["beta", port],
      ]),
    });
    for (const name of ["stopped", "off"]) {
      state.name = name;
      const status = await call(harness, {
        operation: "status",
        parameters: {},
      });
      assert.equal(Reflect.get(Object(status["globalQueue"]), "state"), name);
      assert.equal(
        Reflect.get(Object(status["globalQueue"]), "eligible"),
        name !== "off",
      );
    }
  }));

function submit(
  harness: Harness,
  identity: { readonly workflowId: string; readonly commandId: string },
) {
  return call(harness, {
    operation: "run",
    parameters: {
      ...identity,
      source: "prompt",
      submission: { prompt: identity.commandId },
    },
  });
}

await test("CLV-377 racing admissions across two distinct queues share the global capacity and unrelated manual runs stay outside it", () =>
  withHarness(async (harness) => {
    const limit = { lanes: 1 };
    await harness.start({
      workflows: [
        queued(harness, "alpha"),
        queued(harness, "beta"),
        { ...harness.registration, workflowId: "manual" },
      ],
      queueSettings: {
        global: () => ({
          lanes: limit.lanes,
          sources: { lanes: "queue setting", workingLanes: "default" },
        }),
      },
    });
    const replies = await Promise.all([
      submit(harness, { workflowId: "alpha", commandId: "alpha-1" }),
      submit(harness, { workflowId: "beta", commandId: "beta-1" }),
    ]);
    assert.equal(
      replies.filter((reply) => reply["kind"] === "run-admitted").length,
      1,
      JSON.stringify(replies),
    );
    assert.equal(
      replies.filter((reply) => reply["code"] === "queue-repository-full")
        .length,
      1,
    );
    assert.equal(
      (await submit(harness, { workflowId: "manual", commandId: "manual-1" }))[
        "kind"
      ],
      "run-admitted",
    );
    limit.lanes = 2;
    assert.equal(
      (await submit(harness, { workflowId: "beta", commandId: "beta-2" }))[
        "kind"
      ],
      "run-admitted",
    );
    limit.lanes = 1;
    const status = await call(harness, { operation: "status", parameters: {} });
    const global = status["globalQueue"];
    assert.equal(Reflect.get(Object(global), "busy"), 2);
    assert.equal(Reflect.get(Object(global), "lanes"), 1);
    assert.equal(
      (await submit(harness, { workflowId: "alpha", commandId: "alpha-2" }))[
        "code"
      ],
      "queue-repository-full",
    );
  }));

await test("CLV-377 reload cannot lower the global cap between a concurrent admission and its commit", () =>
  withHarness(async (harness) => {
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const limit = { lanes: 2 };
    let reloads = 0;
    const beta = queued(harness, "beta");
    await harness.start({
      workflows: [
        queued(harness, "alpha"),
        {
          ...beta,
          resolver: {
            ...beta.resolver,
            resolve: async (given) => {
              entered.resolve(undefined);
              await release.promise;
              return beta.resolver.resolve(given);
            },
          },
        },
      ],
      queueSettings: { global: () => limit },
      reload: () => {
        reloads += 1;
        limit.lanes = 1;
        return Promise.resolve({
          kind: "unchanged",
          workflowRefusals: [],
          reloadedFields: [],
          restartFields: [],
        });
      },
    });
    await submit(harness, { workflowId: "alpha", commandId: "first" });
    const admission = submit(harness, {
      workflowId: "beta",
      commandId: "racing",
    });
    await entered.promise;
    const reloading = call(harness, { operation: "reload", parameters: {} });
    try {
      await call(harness, { operation: "status", parameters: {} });
      assert.equal(reloads, 0);
    } finally {
      release.resolve(undefined);
    }
    assert.equal((await admission)["kind"], "run-admitted");
    assert.equal((await reloading)["kind"], "reload");
    const state = await call(harness, { operation: "status", parameters: {} });
    assert.equal(Reflect.get(Object(state["globalQueue"]), "busy"), 2);
    assert.equal(Reflect.get(Object(state["globalQueue"]), "lanes"), 1);
  }));

await test("CLV-377 the global active-work cap admits past a waiting run but counts its owned work conservatively", () =>
  withHarness(async (harness) => {
    const work: string[] = [];
    const service = await harness.start({
      workflows: [queued(harness, "alpha"), queued(harness, "beta")],
      queueSettings: {
        global: () => ({ lanes: 4, workingLanes: 1 }),
        work: () => Promise.resolve({ working: work, github: [] }),
      },
    });
    const first = await submit(harness, {
      workflowId: "alpha",
      commandId: "work-alpha",
    });
    assert.equal(
      (await submit(harness, { workflowId: "beta", commandId: "work-beta" }))[
        "code"
      ],
      "queue-global-working-full",
    );
    const runId = String(first["runId"]);
    await question(service, runId);
    work.push(runId);
    const paused = await call(harness, {
      operation: "run-command",
      parameters: {
        runId,
        command: "pause",
        commandId: "pause-question",
        expectedRevision: 3,
      },
    });
    assert.equal(paused["kind"], "run-command", JSON.stringify(paused));
    assert.equal(
      (
        await submit(harness, {
          workflowId: "beta",
          commandId: "still-working",
        })
      )["code"],
      "queue-global-working-full",
    );
    work.length = 0;
    assert.equal(
      (await submit(harness, { workflowId: "beta", commandId: "free-work" }))[
        "kind"
      ],
      "run-admitted",
    );
  }));

async function question(service: Service, runId: string) {
  await service.worker.started({
    runId,
    commandId: "started",
    expectedRevision: 1,
  });
  const gate = await service.worker.openGate({
    runId,
    commandId: "open",
    expectedRevision: 2,
    gateId: "ask",
    kind: "question",
    prompt: "Continue?",
    subject: digestOf("Continue?"),
  });
  assert.equal(gate.kind, "accepted", JSON.stringify(gate));
  await service.worker.registerWait({
    runId,
    commandId: "wait",
    gateId: "ask",
  });
}
