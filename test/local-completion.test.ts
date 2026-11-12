import assert from "node:assert/strict";
import { test } from "node:test";
import { rendered } from "../src/cli/render.ts";
import { completedDetail } from "../src/cli/watch-render.ts";
import { boardModel } from "./watch-board-fixture.ts";

await test("a completed local run offers review, a plan, and regular maintenance", () => {
  const local = boardModel([
    {
      status: {
        outcome: {
          kind: "handoff_requested",
          reason: null,
          promotionId: `local-${"a".repeat(40)}`,
        },
      },
      events: [],
    },
  ]);
  const [run] = local.runs;
  assert.ok(run);
  assert.match(completedDetail(run), /This local run is complete/);
  assert.match(
    completedDetail(run),
    /cloving init --factory` to add review, a plan, and regular maintenance/,
  );
  const status = rendered({
    kind: "run-status",
    run: {
      outcome: {
        kind: "handoff_requested",
        promotionId: `local-${"b".repeat(40)}`,
      },
    },
  });
  assert.match(status, /cloving init --factory/);
  const pull = boardModel([
    {
      status: {
        outcome: {
          kind: "handoff_requested",
          reason: null,
          promotionId: "pull-request-7",
        },
      },
      events: [],
    },
  ]);
  const [other] = pull.runs;
  assert.ok(other);
  assert.doesNotMatch(completedDetail(other), /init --factory/);
});
