import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Authority } from "../src/broker/actor/authority.ts";
import type { ServiceContext } from "../src/service/replies.ts";
import { status } from "../src/service/run-handlers.ts";
import { workflowRegistry } from "../src/service/registry.ts";
import { recorded } from "./authority-fixture.ts";
import {
  executeStored,
  opened,
  removeTemporaryDirectories,
  storedGate,
  temporaryDirectory,
} from "./authority-store-fixture.ts";
import {
  admitted,
  call,
  field,
  items,
  later,
  noon,
  startedRun,
  text,
  withHarness,
} from "./service-fixture.ts";
import { view } from "./service-views.ts";

const titleCases = [
  [
    "develop-ticket",
    "#  CLV-067: Continue a GitHub operation after a daemon restart  \nDetails",
    "CLV-067: Continue a GitHub operation after a daemon restart",
  ],
  ["develop-issue", "# Issue title\r\nDetails", "Issue title"],
  ["develop-ticket", "No heading\n# Later heading", "Cloving task cycle-title"],
  ["develop-issue", "\n# Later heading", "Cloving task cycle-title"],
  ["develop-ticket", `# ${"t".repeat(201)}`, "t".repeat(200)],
  ["develop-prompt", "\n \t\n#  Prompt heading  \nBody", "Prompt heading"],
  ["develop-prompt", "\n  Plain prompt  \nBody", "Plain prompt"],
  ["develop-prompt", "\n \t\n", "Cloving task cycle-title"],
  ["develop-prompt", "p".repeat(201), "p".repeat(200)],
];

function parsedTicket(value: unknown): unknown {
  return JSON.parse(String(value));
}

function statusContext(authority: Authority): ServiceContext {
  return {
    authority,
    registry: workflowRegistry([]),
    gateway: {
      execute: () =>
        Promise.reject(new Error("Status must not execute commands")),
    },
    clock: () => recorded.recordedAt,
    livenessMilliseconds: 5000,
    followMilliseconds: 20,
    resolverMilliseconds: 1000,
    textBytes: 4096,
    documentBytes: 65536,
  };
}

await test("CLV-072 status shows a completion outcome or null for active and old runs", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const outcomes = [
      { outcome: "handoff_requested" },
      {
        outcome: "blocked",
        outcomeReason: "Greptile gave the confidence score 4/5 in round 4",
      },
      { outcome: "blocked" },
      {},
    ];
    for (const [index, outcome] of outcomes.entries()) {
      const runId = await startedRun(harness, {
        service,
        commandId: `case-${String(index)}`,
      });
      assert.equal(field(await view(harness, runId), "outcome"), null);
      assert.equal(
        (
          await service.worker.submit({
            kind: "complete-run",
            commandId: `end-${String(index)}`,
            runId,
            expectedRevision: 2,
            ...outcome,
          })
        ).kind,
        "accepted",
      );
      assert.deepEqual(
        field(await view(harness, runId), "outcome"),
        outcome.outcome === undefined
          ? null
          : { kind: outcome.outcome, reason: outcome.outcomeReason ?? null },
      );
    }
    await service.close();
  }));

await test("CLV-072 a completion between status reads cannot show completed without its outcome", async () => {
  const { store } = await opened(await temporaryDirectory());
  try {
    for (const command of storedGate.slice(0, 2))
      await executeStored(store, command);
    const context = statusContext({
      ...store,
      queries: {
        ...store.queries,
        sequences: async () => {
          const before = await store.queries.sequences();
          await store.execute(
            {
              kind: "complete-run",
              commandId: "completed",
              runId: "run-1",
              expectedRevision: 2,
              outcome: "blocked",
              outcomeReason: "Review needs repair",
            },
            recorded,
          );
          return before;
        },
      },
    });
    const first = field(
      field(await status(context, { runId: "run-1" }), "result"),
      "run",
    );
    assert.equal(field(first, "state"), "running");
    assert.equal(field(first, "outcome"), null);
    const second = field(
      field(await status(context, { runId: "run-1" }), "result"),
      "run",
    );
    assert.equal(field(second, "state"), "completed");
    assert.deepEqual(field(second, "outcome"), {
      kind: "blocked",
      reason: "Review needs repair",
    });
  } finally {
    await store.close();
  }
});

after(removeTemporaryDirectories);

await test("CLV-072 status derives ticket, issue and prompt titles from the stored input", () =>
  withHarness(async (harness) => {
    const workflows = ["develop-ticket", "develop-issue", "develop-prompt"].map(
      (workflowId) => ({
        ...harness.registration,
        workflowId,
        resolver: {
          ...harness.registration.resolver,
          resolve: (request: {
            readonly submission: Readonly<Record<string, unknown>>;
          }) =>
            Promise.resolve({
              kind: "resolved" as const,
              input: {
                cycleId: "cycle-title",
                ticket: parsedTicket(request.submission["prompt"]),
              },
            }),
        },
      }),
    );
    const service = await harness.start({
      workflows: [...workflows, harness.registration],
    });
    for (const [index, [workflowId, prompt, title]] of titleCases.entries()) {
      const reply = await call(harness, {
        operation: "run",
        parameters: {
          workflowId,
          source: "prompt",
          submission: { prompt: JSON.stringify(prompt) },
          commandId: `title-${String(index)}`,
        },
      });
      assert.equal(
        field(await view(harness, text(reply, "runId")), "title"),
        title,
      );
    }
    const untitled = await admitted(harness, "no-ticket");
    assert.equal(field(await view(harness, untitled), "title"), null);
    await service.close();
  }));

await test("CLV-072 status lists registered workflows in order and each run's latest event time", () =>
  withHarness(async (harness) => {
    let now = noon;
    const workflows = [
      harness.registration,
      { ...harness.registration, workflowId: "unused" },
      {
        ...harness.registration,
        workflowId: "unavailable",
        availability: "unavailable" as const,
      },
    ];
    const service = await harness.start({ workflows, clock: () => now });
    const first = await admitted(harness, "first");
    const second = await admitted(harness, "second");
    now = later;
    await service.worker.started({
      commandId: "started",
      runId: first,
      expectedRevision: 1,
    });
    const list = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(field(list, "workflows"), [
      "develop",
      "unused",
      "unavailable",
    ]);
    assert.deepEqual(
      Object.fromEntries(
        items(field(list, "runs")).map((run) => [
          field(run, "runId"),
          field(run, "latestAt"),
        ]),
      ),
      { [first]: later, [second]: noon },
    );
    await service.close();
  }));
