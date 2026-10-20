import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { candidate, questionCandidate } from "./chats-analysis-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import {
  analysisIntent,
  cycleId,
  withAnalysis,
} from "./chats-worker-fixture.ts";

async function prepared(
  fixture: Parameters<Parameters<typeof withAnalysis>[0]>[0],
) {
  const payload = await fixture.prepare();
  const draft = questionCandidate();
  fixture.payloads.set(
    "save-analysis",
    JSON.stringify({
      ...payload,
      reply: " \n" + JSON.stringify(draft, null, 2),
    }),
  );
  assert.equal((await fixture.deliver("save-analysis")).kind, "completed");
  const text = await readFile(
    join(fixture.directory, `draft-${cycleId}.json`),
    "utf8",
  );
  fixture.payloads.set(
    "final-save",
    JSON.stringify({ ...payload, followUp: { draft, answer: "earlier" } }),
  );
  const intent = {
    ...analysisIntent("save-analysis"),
    operationId: "round-2-save",
    payload: "final-save",
  };
  return { payload, draft, text, intent };
}

await test(
  "CLV-149 a validated final save retains its bound private draft and replays once",
  chatPlatformScenario(() =>
    withAnalysis(async (fixture) => {
      const { intent, text } = await prepared(fixture);
      await fixture.write(
        "redacted.jsonl",
        "changed evidence must not be reread",
      );
      const signal = new AbortController().signal;
      const saved = await fixture.worker.deliver(intent, signal);
      assert.equal(saved.kind, "completed", JSON.stringify(saved));
      assert.ok("result" in saved);
      assert.equal(
        record(JSON.parse(saved.result))?.["kind"],
        "handoff_requested",
      );
      assert.deepEqual(await fixture.worker.reconcile(intent, signal), saved);
      assert.deepEqual(await fixture.worker.deliver(intent, signal), saved);
      assert.equal(
        await readFile(
          join(fixture.directory, `draft-${cycleId}.json`),
          "utf8",
        ),
        text,
      );
      for (const name of [
        `analysis-${cycleId}.json`,
        `proposal-${cycleId}.txt`,
      ])
        assert.equal(
          (await stat(join(fixture.directory, name))).mode & 0o777,
          0o600,
        );
    }),
  ),
);

await test(
  "CLV-149 another question and refused final candidates never write accepted output",
  chatPlatformScenario(() =>
    withAnalysis(async (fixture) => {
      const { intent, payload, draft, text } = await prepared(fixture);
      for (const [reply, reason, code] of [
        [
          JSON.stringify(questionCandidate()),
          "analysis-question-limit",
          "analysis-question-limit",
        ],
        [
          JSON.stringify({ ...candidate(), authority: "old permission" }),
          "analysis-follow-up-refused",
          "authority-field",
        ],
        [
          "not JSON",
          "analysis-follow-up-refused",
          "analysis-follow-up-refused",
        ],
      ]) {
        fixture.payloads.set(
          "final-save",
          JSON.stringify({
            ...payload,
            reply,
            followUp: { draft, answer: "earlier" },
          }),
        );
        const result = await fixture.worker.deliver(
          intent,
          new AbortController().signal,
        );
        assert.equal(result.kind, "failed");
        assert.ok("reason" in result && "result" in result);
        assert.equal(result.reason, reason);
        assert.ok(result.result.includes(code ?? ""));
        assert.equal(
          (await fixture.files()).some((name) =>
            /^(analysis|proposal|final-claim)-/.test(name),
          ),
          false,
        );
      }
      assert.equal(
        await readFile(
          join(fixture.directory, `draft-${cycleId}.json`),
          "utf8",
        ),
        text,
      );
    }),
  ),
);

await test(
  "CLV-149 final saves require the original draft snapshot run and exact answer",
  chatPlatformScenario(() =>
    withAnalysis(async (fixture) => {
      const { intent, payload, draft } = await prepared(fixture);
      const changed = {
        ...draft,
        process: { ...draft.process, name: "changed draft" },
      };
      for (const patch of [
        { followUp: { draft: changed, answer: "earlier" } },
        { followUp: { draft, answer: "earlier with extra text" } },
        {
          snapshot: {
            ...payload.snapshot,
            corpus: payload.snapshot.corpus + "\n",
          },
        },
      ]) {
        fixture.payloads.set(
          "final-save",
          JSON.stringify({
            ...payload,
            followUp: { draft, answer: "earlier" },
            ...patch,
          }),
        );
        const result = await fixture.worker.deliver(
          intent,
          new AbortController().signal,
        );
        assert.equal(result.kind, "failed");
        assert.ok("reason" in result);
        assert.equal(result.reason, "analysis-follow-up-refused");
      }
      fixture.payloads.set(
        "final-save",
        JSON.stringify({ ...payload, followUp: { draft, answer: "earlier" } }),
      );
      assert.equal(
        (
          await fixture.worker.deliver(
            { ...intent, runId: "other-run" },
            new AbortController().signal,
          )
        ).kind,
        "failed",
      );
      assert.equal(
        (await fixture.files()).some((name) =>
          /^(analysis|proposal|final-claim)-/.test(name),
        ),
        false,
      );
    }),
  ),
);
