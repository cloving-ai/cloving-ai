import assert from "node:assert/strict";
import { test } from "node:test";
import { boardModel, boardRun } from "./watch-board-fixture.ts";

await test("CLV-148 operational analysis decisions hide private prompt and feedback", () => {
  const prompt = "private synthetic analysis question";
  const model = boardModel(
    [
      boardRun("analysis", {
        workflowId: "analyze-chats",
        state: "waiting_gate",
      }),
    ],
    {
      decisions: [
        {
          runId: "analysis",
          decisionId: "analysis/analysis-question",
          type: "question",
          prompt,
          feedback: [{ text: prompt }],
        },
      ],
    },
  );
  const pending = model.runs[0]?.decisions;
  assert.ok(pending);
  assert.equal(pending.length, 1);
  assert.equal(JSON.stringify(model).includes(prompt), false);
  assert.equal(
    pending[0]?.prompt,
    "Private analysis question. Run cloving questions to view it.",
  );
});
