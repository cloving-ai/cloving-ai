import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenario } from "../src/testing.ts";
import {
  workflow,
  input,
  effects,
  completed,
} from "./develop-template-flow-fixture.ts";

await test("CLV-123 template merges preserve structured status after a shortened report", async () => {
  for (const status of [
    { kind: "complete" },
    { kind: "partial", remaining: ["Add recovery.", "Verify restart."] },
  ]) {
    const result = await runScenario({
      workflow,
      exportName: "develop",
      input,
      effects: {
        ...effects(),
        "claude run-turn": [
          completed({ summary: "Shortened report.", ticketStatus: status }),
        ],
        "github partial-issue": [completed({})],
      },
    });
    assert.deepEqual(result.outcome, {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "pull-request-7",
      ticketStatus: status.kind,
    });
    const update = result.requests.at(-1);
    assert.ok(update && update[0] === "effect");
    assert.equal(
      update[1].method,
      status.kind === "complete" ? "close-issue" : "partial-issue",
    );
    assert.deepEqual(JSON.parse(update[1].payload), {
      owner: "acme",
      repository: "demo",
      number: 42,
      pullRequest: 7,
      ...(status.remaining ? { remaining: status.remaining } : {}),
    });
  }
});

await test("CLV-123 template issue updates preserve the supplied repository", async () => {
  const result = await runScenario({
    workflow,
    exportName: "develop",
    input: {
      ...input,
      input: {
        ticket: {
          ...input.input.ticket,
          text: input.input.ticket.text.replace(
            "acme/demo#42",
            "other/project#63",
          ),
        },
      },
    },
    effects: effects(),
  });
  const opened = result.requests[3];
  assert.ok(opened && opened[0] === "effect");
  assert.match(opened[1].payload, /Refs other\/project#63/);
  const update = result.requests.at(-1);
  assert.ok(update && update[0] === "effect");
  assert.equal(update[1].method, "close-issue");
  assert.deepEqual(JSON.parse(update[1].payload), {
    owner: "other",
    repository: "project",
    number: 63,
    pullRequest: 7,
  });
});

await test("CLV-123 template fixes preserve remaining work until reassessment", async () => {
  const scenario = effects();
  for (const key of ["github open-pr", "github wait-review"] as const)
    scenario[key] = [...scenario[key], ...scenario[key], ...scenario[key]];
  const result = await runScenario({
    workflow,
    exportName: "develop",
    input,
    effects: {
      ...scenario,
      "claude run-turn": [
        completed({
          summary: "Shortened report.",
          ticketStatus: {
            kind: "partial",
            remaining: ["Add recovery.", "Verify restart."],
          },
        }),
        completed({
          summary: "Remaining:\n- Verify restart.\nTicket status: partial",
        }),
        completed({ summary: "Checked.\nTicket status: complete" }),
      ],
      "github merge": [
        completed({ reason: "check-failed", output: "Fix the checks." }),
        completed({
          reason: "merge-conflict",
          output: "Resolve the conflict.",
        }),
        ...scenario["github merge"],
      ],
    },
  });
  const prompts = result.requests.flatMap((request) =>
    request[0] === "effect" && request[1].method === "run-turn"
      ? [request[1].payload]
      : [],
  );
  assert.equal(prompts.length, 3);
  assert.match(prompts[1] ?? "", /- Add recovery\.\n- Verify restart\./);
  assert.match(prompts[2] ?? "", /- Verify restart\./);
  assert.doesNotMatch(prompts[2] ?? "", /- Add recovery\./);
  assert.match(prompts[1] ?? "", /Reassess every unfinished item/);
  assert.deepEqual(result.outcome, {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "pull-request-7",
    ticketStatus: "complete",
  });
});
