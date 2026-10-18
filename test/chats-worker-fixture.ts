import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryIntent } from "../src/broker/actor/delivery-intents.ts";
import { chatsWorker } from "../src/daemon/chats-worker.ts";
import { record } from "../src/protocol.ts";
import { isAnalysisSnapshot } from "../src/chats/analysis-input.ts";
import { emptyCounts } from "../src/chats/redaction.ts";
import { candidate, records, structure } from "./chats-analysis-fixture.ts";

export const importId = "11111111-1111-4111-8111-111111111111";
export const cycleId = "synthetic-cycle";
export const manifest = {
  schemaVersion: 1,
  ruleVersion: 1,
  importId,
  recordCount: records.length,
  counts: emptyCounts(),
  totalCount: 0,
};
export const corpus = records
  .map((message) => JSON.stringify(message) + "\n")
  .join("");
export const sidecar = { schemaVersion: 1, importId, ...structure };

export function analysisIntent(method: string): DeliveryIntent {
  return {
    kind: "protected-effect",
    runId: cycleId,
    operationId: `chats:${method}`,
    workflow: "manifest",
    inputDigest: method,
    purpose: "dispatch",
    capability: "chats",
    method,
    target: importId,
    payload: method,
    leaseGeneration: 1,
  };
}

export async function withAnalysis(
  run: (fixture: Awaited<ReturnType<typeof analysisFixture>>) => Promise<void>,
): Promise<void> {
  const fixture = await analysisFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.runtimeDirectory, { recursive: true, force: true });
  }
}

async function analysisFixture() {
  const runtimeDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "cloving-analysis-")),
  );
  const directory = join(runtimeDirectory, "chats", importId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const payloads = new Map([["read-analysis", JSON.stringify({ importId })]]);
  const context = { workflow: "analyze-chats" };
  const settings = {
    runtimeDirectory,
    document: (digest: string) => Promise.resolve(payloads.get(digest)),
    workflowId: () => Promise.resolve(context.workflow),
  };
  const worker = chatsWorker(settings);
  const write = (name: string, value: unknown) =>
    writeFile(
      join(directory, name),
      typeof value === "string" ? value : JSON.stringify(value),
      { mode: 0o600 },
    );
  await write("redaction.json", manifest);
  await write("redacted.jsonl", corpus);
  await write("structure.json", sidecar);
  const deliver = (method: string) =>
    worker.deliver(analysisIntent(method), new AbortController().signal);
  const capture = async () => {
    const result = await deliver("read-analysis");
    assert.equal(result.kind, "completed", JSON.stringify(result));
    assert.ok("result" in result);
    const value = record(JSON.parse(result.result));
    const snapshot = value?.["snapshot"];
    assert.ok(isAnalysisSnapshot(snapshot));
    return snapshot;
  };
  const prepare = async () => {
    const snapshot = await capture();
    const payload = {
      importId,
      cycleId,
      snapshot,
      reply: JSON.stringify(candidate()),
    };
    payloads.set("save-analysis", JSON.stringify(payload));
    return payload;
  };
  return {
    runtimeDirectory,
    directory,
    settings,
    context,
    worker,
    payloads,
    write,
    deliver,
    capture,
    prepare,
    files: () => readdir(directory),
  };
}

export function assertRefused(value: unknown, code: string): void {
  const result = record(value);
  assert.equal(result?.["kind"], "failed", JSON.stringify(value));
  assert.equal(result["reason"], code);
}
