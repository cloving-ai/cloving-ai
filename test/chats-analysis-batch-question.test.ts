import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { batchCorpus } from "./analyze-chats-batches-fixture.ts";
import { batch, questionBatch } from "./chats-analysis-merge-fixture.ts";
import { draftSecondBatch } from "./chats-analysis-batch-question-fixture.ts";
import { ref } from "./chats-analysis-fixture.ts";
import {
  assertRefused,
  cycleId,
  importId,
  withAnalysis,
} from "./chats-worker-fixture.ts";

await test(
  "CLV-160 batch drafts reject references outside the captured processed prefix",
  chatPlatformScenario(() =>
    withAnalysis(async (fixture) => {
      await fixture.write("redacted.jsonl", batchCorpus());
      const read = await fixture.deliver("read-analysis");
      assert.ok("result" in read);
      const captured = record(JSON.parse(read.result));
      assert.ok(captured);
      const candidate = questionBatch();
      candidate.openQuestion.sourceRefs.push(ref(15));
      fixture.payloads.set(
        "save-analysis",
        JSON.stringify({
          importId,
          cycleId,
          batch: captured["batch"],
          reply: JSON.stringify(candidate),
        }),
      );
      assertRefused(await fixture.deliver("save-analysis"), "unknown-source");
      assert.equal(
        (await fixture.files()).some((name) => name.startsWith("draft-")),
        false,
      );
    }),
  ),
);

await test(
  "CLV-160 a pending question preserves retries of earlier committed batches and refuses a commit without its answer",
  chatPlatformScenario(() =>
    withAnalysis(async (fixture) => {
      const { save, base, folder, before, firstPayload, accepted } =
        await draftSecondBatch(fixture);
      assert.deepEqual(await save("first-batch", firstPayload), accepted);
      const { followUp, ...unanswered } = base;
      assert.equal(followUp.answer, "first");
      assertRefused(
        await save("unanswered", unanswered),
        "analysis-output-failed",
      );
      assert.deepEqual(await readdir(join(fixture.directory, folder)), before);
    }),
  ),
);

await test(
  "CLV-160 an answer cannot change its bound batch draft or listed choice before checkpoint commit",
  chatPlatformScenario(() =>
    withAnalysis(async (fixture) => {
      const { save, base, binding, draft, folder, before } =
        await draftSecondBatch(fixture);
      for (const changed of [
        { batch: { ...binding, batchIndex: 0 } },
        { batch: { ...binding, capturedDigest: "a".repeat(64) } },
        { batch: { ...binding, nextRecordIndex: 16 } },
        {
          followUp: {
            draft: { ...draft, process: batch().process },
            answer: "first",
          },
        },
        { followUp: { draft, answer: "unknown" } },
        { followUp: { draft, answer: "first " } },
      ]) {
        assertRefused(
          await save("follow-up", { ...base, ...changed }),
          "analysis-follow-up-refused",
        );
        assert.deepEqual(
          await readdir(join(fixture.directory, folder)),
          before,
        );
      }
      assert.equal((await save("follow-up", base)).kind, "completed");
      assert.equal((await save("follow-up", base)).kind, "completed");
      const checkpoint = record(
        JSON.parse(
          await readFile(
            join(fixture.directory, folder, "analysis-checkpoint-2.json"),
            "utf8",
          ),
        ),
      );
      assert.equal(checkpoint?.["covered"], 14);
      assert.equal(checkpoint["completedBatchCount"], 2);
    }),
  ),
);
