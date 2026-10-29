import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runScenario } from "../src/testing.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  configuredIdeaFiles,
  prefix,
} from "./idea-template-options-fixture.ts";

const completed = (result: unknown = null) => ({
  kind: "completed" as const,
  operationId: "operation",
  receipt: null,
  result: JSON.stringify(result),
});
const digest = `sha256:${"a".repeat(64)}`;

for (const point of ["review", "post"])
  await test(`CLV-222 an oversized ${point} capture blocks before a gate or post`, async () => {
    await withFiles(
      await configuredIdeaFiles({
        review: point === "review" ? "person" : "turn",
        post: point === "post" ? "person" : "privacy",
        next: "nothing",
      }),
      async (directory) => {
        const result = await runScenario({
          workflow: join(directory, prefix, "idea-to-issue.ts"),
          exportName: "ideaToIssue",
          input: { cycleId: "idea-1", input: { idea: "Show costs." } },
          effects: {
            "github prepare": [completed()],
            "claude run-turn": [completed(), completed()],
            "github capture-draft": [
              {
                kind: "failed",
                operationId: "capture",
                reason: "draft-too-large",
              },
            ],
          },
        });
        assert.deepEqual(result.outcome, {
          kind: "blocked",
          evidenceId: "idea-to-issue",
          cycleId: "idea-1",
          reason: "draft-too-large",
        });
        assert.ok(result.requests.every((request) => request[0] === "effect"));
        assert.equal(result.requests.length, point === "review" ? 3 : 4);
        const capture = result.requests.at(-1);
        assert.ok(capture);
        assert.equal(capture[1].method, "capture-draft");
      },
    );
  });

for (const point of ["review", "post"])
  for (const decision of ["denied", "expired"] as const)
    await test(`CLV-222 ${decision} ${point} preserves the draft and posts no issue`, async () => {
      const selected = {
        review: point === "review" ? "person" : "turn",
        post: point === "post" ? "person" : "privacy",
        next: "nothing",
      };
      await withFiles(
        await configuredIdeaFiles(selected),
        async (directory) => {
          const result = await runScenario({
            workflow: join(directory, prefix, "idea-to-issue.ts"),
            exportName: "ideaToIssue",
            input: { cycleId: "idea-1", input: { idea: "Show costs." } },
            effects: {
              "github prepare": [completed()],
              "claude run-turn": [completed(), completed()],
              "github capture-draft": [
                completed({ text: "# Costs\nShow costs.", digest }),
              ],
            },
            decisions: [{ decision, answer: "Stop." }],
          });
          assert.deepEqual(result.outcome, {
            kind: "blocked",
            evidenceId: "idea-to-issue",
            cycleId: "idea-1",
            reason:
              point === "review" ? "draft-review-denied" : "post-not-approved",
          });
          const methods = result.requests.flatMap((request) =>
            request[0] === "effect" ? [request[1].method] : [],
          );
          assert.ok(!methods.includes("create-issue"));
          assert.ok(!methods.includes("discard"));
        },
      );
    });
