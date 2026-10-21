import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { record } from "../src/protocol.ts";
import { batchCorpus } from "./analyze-chats-batches-fixture.ts";
import { batch, questionBatch } from "./chats-analysis-merge-fixture.ts";
import {
  analysisIntent,
  cycleId,
  importId,
  type withAnalysis,
} from "./chats-worker-fixture.ts";

type AnalysisFixture = Parameters<Parameters<typeof withAnalysis>[0]>[0];

export async function draftSecondBatch(fixture: AnalysisFixture) {
  await fixture.write("redacted.jsonl", batchCorpus());
  const read = await fixture.deliver("read-analysis");
  assert.ok("result" in read);
  const first = record(JSON.parse(read.result));
  assert.ok(first);
  const save = async (key: string, payload: unknown) => {
    fixture.payloads.set(key, JSON.stringify(payload));
    return fixture.worker.deliver(
      {
        ...analysisIntent("save-analysis"),
        operationId: key,
        payload: key,
        inputDigest: key,
      },
      new AbortController().signal,
    );
  };
  const firstPayload = {
    importId,
    cycleId,
    batch: first["batch"],
    reply: JSON.stringify(batch()),
  };
  const accepted = await save("first-batch", firstPayload);
  assert.ok("result" in accepted);
  const second = record(JSON.parse(accepted.result));
  assert.ok(second);
  const binding = record(second["batch"]);
  assert.ok(binding);
  const draft = questionBatch();
  const drafted = await save("draft-batch", {
    importId,
    cycleId,
    batch: binding,
    reply: JSON.stringify(draft),
  });
  assert.equal(drafted.kind, "completed");
  const base = {
    importId,
    cycleId,
    batch: binding,
    reply: JSON.stringify(batch()),
    followUp: { draft, answer: "first" },
  };
  const folder = (await fixture.files()).find((name) =>
    name.startsWith("capture-"),
  );
  assert.ok(folder);
  const before = await readdir(join(fixture.directory, folder));
  return { save, base, binding, draft, folder, before, firstPayload, accepted };
}
