import assert from "node:assert/strict";
import { test } from "node:test";
import {
  childRuns,
  handoffChain,
  type RunOrigins,
} from "../src/authority/handoff-chain.ts";
import { operationOf } from "./effect-fixture.ts";
import { call, withHarness } from "./service-fixture.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import { fakeRegistration } from "./service-fixture.ts";
import { workflowRegistry } from "../src/service/registry.ts";
import { submissionHandler } from "../src/service/submission-handler.ts";
import { commandGateway } from "../src/service/gateway.ts";

const command = (runId: string) =>
  `handoff:${operationOf(runId, { round: 1 })}`;

await test("CLV-183 ordinary submissions skip history while handoffs read recorded origins", () =>
  withHarness(async (harness) => {
    const authority = await openedAuthority(harness.stateDirectory);
    harness.cleanup(() => authority.close());
    let reads = 0;
    const registry = workflowRegistry([fakeRegistration([])]);
    const clock = () => "2026-10-24T12:00:00.000Z";
    const submit = submissionHandler({
      authority: {
        ...authority,
        queries: {
          ...authority.queries,
          runOrigins: () => {
            reads += 1;
            return authority.queries.runOrigins();
          },
        },
      },
      registry,
      clock,
      gateway: commandGateway({ authority, registry, clock, textBytes: 4096 }),
      livenessMilliseconds: 1000,
      followMilliseconds: 20,
      resolverMilliseconds: 1000,
      textBytes: 4096,
      documentBytes: 4096,
    });
    const parameters = {
      workflowId: "develop",
      source: "prompt",
      submission: { prompt: "next" },
      commandId: "history-root",
    };
    const root = await submit(parameters);
    assert.equal(root.kind, "result");
    assert.equal(reads, 0);
    const child = await submit({
      ...parameters,
      commandId: command(String(root.result["runId"])),
    });
    assert.equal(child.kind, "result");
    assert.equal(reads, 1);
    assert.equal(
      (await submit({ ...parameters, commandId: "other" })).kind,
      "result",
    );
    assert.equal(reads, 1);
  }));

await test("CLV-183 chain policy counts ancestry, permits siblings and refuses missing parents and cycles", () => {
  const origins: RunOrigins = {
    root: { parentRunId: null, chainId: "root" },
    child: { parentRunId: "root", chainId: "root" },
    sibling: { parentRunId: "root", chainId: "root" },
    missing: { parentRunId: "absent", chainId: "absent" },
    cycle: { parentRunId: "cycle", chainId: "cycle" },
  };
  assert.deepEqual(handoffChain("operator-command", origins), { kind: "root" });
  for (const parent of ["root", "child", "sibling"])
    assert.deepEqual(handoffChain(command(parent), origins), {
      kind: "handoff",
      parentRunId: parent,
      chainId: "root",
    });
  for (const invalid of [
    command("absent"),
    command("missing"),
    "handoff:invalid",
  ])
    assert.deepEqual(handoffChain(invalid, origins), {
      kind: "refused",
      reason: "unknown-handoff-parent",
    });
  assert.deepEqual(handoffChain(command("cycle"), origins), {
    kind: "refused",
    reason: "chain-limit",
  });
  assert.deepEqual(childRuns(origins), {
    root: ["child", "sibling"],
    absent: ["missing"],
    cycle: ["cycle"],
  });
});

await test("CLV-183 chain-limit survives restart, starts no run and does not invoke the resolver", () =>
  withHarness(async (harness) => {
    const first = await harness.start();
    const submit = (commandId: string) =>
      call(harness, {
        operation: "run",
        parameters: {
          workflowId: "develop",
          source: "input",
          submission: { prompt: "next" },
          commandId,
        },
      });
    let last = String((await submit("root"))["runId"]);
    for (let length = 2; length <= 5; length += 1)
      last = String((await submit(command(last)))["runId"]);
    assert.equal(harness.resolved.length, 5);
    await first.close();
    const second = await harness.start();
    assert.equal((await submit(command(last)))["code"], "chain-limit");
    assert.equal(harness.resolved.length, 5);
    const listed = await call(harness, { operation: "status", parameters: {} });
    assert.ok(Array.isArray(listed["runs"]));
    assert.equal(listed["runs"].length, 5);
    await second.close();
  }));
