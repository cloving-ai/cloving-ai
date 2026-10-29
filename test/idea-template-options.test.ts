import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { ScenarioRequest } from "../src/testing.ts";
import { runScenario } from "../src/testing.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  configuredIdeaFiles,
  configurations,
  prefix,
} from "./idea-template-options-fixture.ts";

import {
  effects as ideaEffects,
  digest,
  text,
  effectPayloads,
  readyLabel,
} from "../templates/idea-to-issue/idea-to-issue/scenarios.ts";

for (const selected of configurations)
  await test(`CLV-222 selected ${Object.values(selected).join("/")} captures before gates and delivers the issue`, async () => {
    await withFiles(await configuredIdeaFiles(selected), async (directory) => {
      const result = await runScenario({
        workflow: join(directory, prefix, "idea-to-issue.ts"),
        exportName: "ideaToIssue",
        input: { cycleId: "idea-1", input: { idea: "Show costs." } },
        effects: ideaEffects(),
        decisions: [
          { decision: "approved", answer: null },
          { decision: "approved", answer: null },
        ],
      });
      assert.deepEqual(result.outcome, {
        kind: "handoff_requested",
        cycleId: "idea-1",
        promotionId: "issue-42",
      });
      const humanCount =
        Number(selected.review === "person") +
        Number(selected.post === "person");
      checkCaptures(result.requests, humanCount);
      assert.equal(
        result.requests.filter((request) => request[0] === "handoff").length,
        Number(selected.next === "develop"),
      );
      assert.deepEqual(
        effectPayloads(result.requests, "label"),
        selected.next === "queue" ? [readyLabel] : [],
      );
    });
  });

function checkCaptures(
  requests: readonly ScenarioRequest[],
  humanCount: number,
): void {
  const gates = requests.filter((request) => request[0] === "waitForDecision");
  assert.equal(gates.length, humanCount);
  for (const gate of gates) {
    assert.ok(gate[1].prompt.includes(text));
    const before = requests[requests.indexOf(gate) - 1];
    assert.ok(
      before && before[0] === "effect" && before[1].method === "capture-draft",
    );
  }
  const post = requests.find(
    (request) =>
      request[0] === "effect" && request[1].method === "create-issue",
  );
  assert.ok(post && post[0] === "effect");
  assert.deepEqual(JSON.parse(post[1].payload), {
    draft: "cloving-prd-draft.md",
    ...(humanCount === 0
      ? {}
      : {
          expectedDigests: Array.from({ length: humanCount }, () => digest),
        }),
  });
}
