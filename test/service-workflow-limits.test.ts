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

const handoff = (runId: unknown) =>
  `handoff:${operationOf(String(runId), { round: 1 })}`;

function runIdOf(reply: Reply): unknown {
  return reply.kind === "result" ? reply.result["runId"] : undefined;
}

function codeOf(reply: Reply): unknown {
  return reply.kind === "error" ? reply.error["code"] : undefined;
}

await test("CLV-308 a chain limit of 8 starts 7 handoffs and refuses the 8th, also after a reload lowers it", () =>
  withHarness(async (harness) => {
    const service = await limitedService(harness, { chainLimit: 8 });
    let last = runIdOf(await service.submit("chain-root"));
    assert.equal(typeof last, "string");
    service.registry.replace([{ ...fakeRegistration([]), chainLimit: 3 }]);
    for (let handoffs = 1; handoffs <= 7; handoffs += 1) {
      const child = await service.submit(handoff(last));
      assert.equal(child.kind, "result", JSON.stringify(child));
      last = runIdOf(child);
    }
    assert.equal(codeOf(await service.submit(handoff(last))), "chain-limit");
  }));

await test("CLV-308 a reload that lowers effectLimit does not change the budget of an active run", () =>
  withHarness(async (harness) => {
    const service = await limitedService(harness, { effectLimit: 10 });
    const runId = String(runIdOf(await service.submit("budget-root")));
    service.registry.replace([{ ...fakeRegistration([]), effectLimit: 2 }]);
    const budget = await service.authority.effects.budget(runId);
    assert.deepEqual(
      { limit: budget?.limit, spent: budget?.spent },
      { limit: 10, spent: 0 },
    );
    const later = String(runIdOf(await service.submit("budget-later")));
    assert.equal((await service.authority.effects.budget(later))?.limit, 2);
  }));
