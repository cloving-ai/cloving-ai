import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { field } from "./develop-workflow-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import {
  analysisSource as source,
  analysisSetup as setup,
} from "./analyze-chats-sdk-fixture.ts";

await test(
  "CLV-116 compiled Local World replay reuses a durable completed private reply before report delivery and saves once",
  chatPlatformScenario(() =>
    withConsumer(source, async (consumer) => {
      const first = await consumer.runUntil(
        "completed-private-result",
        `writeFileSync("halt-before-report", "");${setup}
print({ runId: await submitAnalysis() });
`,
      );
      assert.equal(
        field(first.lines[1], "boundary"),
        "completed-private-result",
        first.stderr,
      );
      const runId = String(field(first.lines[0], "runId"));
      const second = await consumer.run(
        `rmSync("halt-before-report");${setup}
await finished(process.env.RUN_ID);
`,
        { RUN_ID: runId },
      );
      assert.equal(
        second.status,
        0,
        second.stderr + JSON.stringify(second.lines),
      );
      const line = second.lines[0];
      assert.equal(
        field(line, "state"),
        "completed",
        JSON.stringify(second.lines),
      );
      assert.deepEqual(field(line, "budget"), { limit: 3, spent: 3 });
      assert.equal(field(line, "turns"), 1);
      assert.equal(field(line, "usageTurns"), 1);
      assert.equal(field(line, "cost"), 0.25);
      assert.deepEqual(field(line, "usage"), {
        input_tokens: 1500,
        cache_read_input_tokens: 800,
        output_tokens: 150,
      });
      assert.equal(field(line, "safe"), true);
      assert.equal(field(field(line, "outputs"), "length"), 2);
    }),
  ),
);

await test(
  "CLV-116 compiled Local World interruption blocks and never launches a replacement turn",
  chatPlatformScenario(() =>
    withConsumer(source, async (consumer) => {
      const first = await consumer.runUntil(
        "interrupted-turn",
        `writeFileSync("interrupt", "");${setup}
const runId = await submitAnalysis();
await until(() => lines("turns.log").length === 1);
const turn = JSON.parse(lines("turns.log")[0]);
process.kill(turn.processId, "SIGKILL");
await until(() => !existsSync("worktrees"));
await halt("interrupted-turn", { runId });
`,
      );
      assert.equal(
        field(first.lines[0], "boundary"),
        "interrupted-turn",
        first.stderr,
      );
      const second = await consumer.run(
        `${setup}
await finished(process.env.RUN_ID);
`,
        { RUN_ID: String(field(first.lines[0], "runId")) },
      );
      assert.equal(
        second.status,
        0,
        second.stderr + JSON.stringify(second.lines),
      );
      assert.equal(field(second.lines[0], "state"), "completed");
      assert.deepEqual(field(second.lines[0], "outcome"), {
        kind: "blocked",
        reason: "analysis-turn-failed",
      });
      assert.equal(field(second.lines[0], "turns"), 1);
      assert.deepEqual(field(second.lines[0], "budget"), {
        limit: 3,
        spent: 2,
      });
      assert.equal(field(field(second.lines[0], "outputs"), "length"), 0);
    }),
  ),
);

await test(
  "CLV-148 compiled Local World recovers a private draft and opens one bound question without finalizing",
  chatPlatformScenario(() =>
    withConsumer(source, async (consumer) => {
      const first = await consumer.runUntil(
        "saved-private-draft",
        `writeFileSync("draft-question", ""); writeFileSync("halt-after-draft", "");${setup}
print({ runId: await submitAnalysis() });`,
      );
      const boundary = first.lines[1];
      assert.equal(
        field(boundary, "boundary"),
        "saved-private-draft",
        first.stderr,
      );
      const second = await consumer.run(
        `rmSync("halt-after-draft");${setup}
await finished(process.env.RUN_ID);`,
        { RUN_ID: String(field(first.lines[0], "runId")) },
      );
      assert.equal(
        second.status,
        0,
        second.stderr + JSON.stringify(second.lines),
      );
      const line = second.lines[0];
      assert.equal(field(line, "drafts"), 1);
      assert.equal(field(line, "expiresAt"), field(boundary, "expiresAt"));
      assert.equal(
        field(line, "candidateDigest"),
        field(boundary, "candidateDigest"),
      );
      assert.equal(field(line, "state"), "waiting_gate");
      assert.equal(field(line, "gates"), 1);
      assert.equal(field(line, "expiresMatch"), true);
      assert.equal(field(line, "candidateBound"), true);
      assert.deepEqual(field(line, "budget"), { limit: 3, spent: 3 });
      assert.equal(field(line, "turns"), 1);
      assert.equal(field(line, "usageTurns"), 1);
      assert.equal(field(line, "safe"), true);
      assert.deepEqual(field(line, "outputs"), []);
    }),
  ),
);
