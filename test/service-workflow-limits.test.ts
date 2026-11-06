import assert from "node:assert/strict";
import { test } from "node:test";
import { operationOf } from "./effect-fixture.ts";
import { fakeRegistration, withHarness } from "./service-fixture.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  replaceableRegistry,
  type WorkflowRegistration,
} from "../src/service/registry.ts";
import { submissionHandler } from "../src/service/submission-handler.ts";
import { commandGateway } from "../src/service/gateway.ts";
import type { Harness } from "./service-fixture.ts";
import type { Reply } from "../src/protocol.ts";

async function limitedService(
  harness: Harness,
  registration: Partial<WorkflowRegistration>,
) {
  const authority = await openedAuthority(harness.stateDirectory);
  harness.cleanup(() => authority.close());
  const registry = replaceableRegistry([
    { ...fakeRegistration([]), ...registration },
  ]);
  const clock = () => "2026-11-06T12:00:00.000Z";
  const submit = submissionHandler({
    authority,
    registry,
    clock,
    gateway: commandGateway({ authority, registry, clock, textBytes: 4096 }),
    livenessMilliseconds: 1000,
    followMilliseconds: 20,
    resolverMilliseconds: 1000,
    textBytes: 4096,
    documentBytes: 4096,
  });
  return {
    authority,
    registry,
    submit: (commandId: string) =>
      submit({
        workflowId: "develop",
        source: "prompt",
        submission: { prompt: "next" },
        commandId,
      }),
  };
}

const handoff = (runId: string) =>
  `handoff:${operationOf(runId, { round: 1 })}`;

function runIdOf(reply: Reply): string {
  assert.ok(reply.kind === "result", JSON.stringify(reply));
  const runId = reply.result["runId"];
  assert.ok(typeof runId === "string", JSON.stringify(reply));
  return runId;
}

function codeOf(reply: Reply): string {
  assert.ok(reply.kind === "error", JSON.stringify(reply));
  return reply.error.code;
}

await test("CLV-308 a chain limit of 8 starts 7 handoffs and refuses the 8th, also after a reload lowers it", () =>
  withHarness(async (harness) => {
    const service = await limitedService(harness, { chainLimit: 8 });
    let last = runIdOf(await service.submit("chain-root"));
    service.registry.replace([{ ...fakeRegistration([]), chainLimit: 3 }]);
    for (let handoffs = 1; handoffs <= 7; handoffs += 1) {
      last = runIdOf(await service.submit(handoff(last)));
    }
    assert.equal(codeOf(await service.submit(handoff(last))), "chain-limit");
  }));

await test("CLV-308 a reload that lowers effectLimit does not change the budget of an active run", () =>
  withHarness(async (harness) => {
    const service = await limitedService(harness, { effectLimit: 10 });
    const runId = runIdOf(await service.submit("budget-root"));
    service.registry.replace([{ ...fakeRegistration([]), effectLimit: 2 }]);
    const budget = await service.authority.effects.budget(runId);
    assert.deepEqual(
      { limit: budget?.limit, spent: budget?.spent },
      { limit: 10, spent: 0 },
    );
    const later = runIdOf(await service.submit("budget-later"));
    assert.equal((await service.authority.effects.budget(later))?.limit, 2);
  }));

await test("CLV-308 the admission pins the spend limit of the workflow, and a reload does not change it", () =>
  withHarness(async (harness) => {
    const service = await limitedService(harness, { spendLimitUsd: 2 });
    const runId = runIdOf(await service.submit("spend-root"));
    service.registry.replace([{ ...fakeRegistration([]), spendLimitUsd: 1 }]);
    const later = runIdOf(await service.submit("spend-later"));
    const pinned = async (id: string) =>
      (
        await service.authority.queries.eventsAfter({
          runId: id,
          after: 0,
          limit: 1,
        })
      ).events[0]?.payload["spendLimitUsd"];
    assert.deepEqual([await pinned(runId), await pinned(later)], ["2", "1"]);
  }));
