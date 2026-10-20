import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { claudeLimits } from "../src/daemon/claude-worker.ts";
import { field, intent, until, withScene } from "./claude-worker-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import {
  generatedArtifact,
  generatedPrelude,
} from "./chats-workflow-generation-sdk-fixture.ts";

await test("CLV-122 generated prompts bound summary JSON to the real worker retention limit", () => {
  for (const asset of generatedArtifact().assets)
    assert.match(
      asset.instructions,
      /final summary JSON must fit within 16,000 UTF-8 bytes/,
    );
  assert.equal(claudeLimits.summaryCharacters, 16_000);
});

async function convertedSummary(summary: string): Promise<string> {
  return withScene(async (scene) => {
    writeFileSync(join(scene.directory, "turns.log.reply"), summary);
    const worker = scene.worker("fixed-reply");
    await worker.deliver(intent(), new AbortController().signal);
    await until(() => scene.reports.length === 1);
    const converted = scene.reports[0]?.result;
    assert.equal(typeof converted, "string");
    assert.equal(
      field(JSON.parse(String(converted)), "summary"),
      summary.slice(0, claudeLimits.summaryCharacters),
    );
    return String(converted);
  });
}

for (const [bytes, character] of [
  [16_000, "x"],
  [16_001, "x"],
  [16_000, "🧪"],
  [16_001, "🧪"],
] as const)
  await test(`CLV-122 real worker conversion and SDK enforce the ${String(bytes)} byte summary boundary with ${character}`, async () => {
    const empty = JSON.stringify({ status: "repair", findings: "" });
    const space = bytes - Buffer.byteLength(empty);
    const width = Buffer.byteLength(character);
    const summary = JSON.stringify({
      status: "repair",
      findings:
        character.repeat(Math.floor(space / width)) + "x".repeat(space % width),
    });
    assert.equal(Buffer.byteLength(summary), bytes);
    const converted = await convertedSummary(summary);
    const fits = bytes === 16_000;
    await withConsumer(generatedArtifact().source, async (consumer) => {
      const result = await consumer.run(`${generatedPrelude()}
const worker = { ...destination, deliver: async (intent) => {
  const outcome = await destination.deliver(intent);
  return lines("destination.log").length === 1 ? { ...outcome, result: ${JSON.stringify(converted)} } : outcome;
} };
const service = await openGenerated({ destination: worker });
const runId = await submitGenerated();
await terminal(runId);
print(await generatedState(runId));
await service.close();
`);
      assert.equal(result.status, 0, result.stderr);
      const state: unknown = result.lines[0];
      assert.equal(field(state, "sends"), fits ? 3 : 1);
      assert.equal(field(state, "state"), fits ? "waiting_gate" : "completed");
      assert.deepEqual(field(state, "budget"), {
        limit: 6,
        spent: fits ? 3 : 1,
      });
      const segments: unknown = field(state, "segments");
      assert.ok(Array.isArray(segments));
      assert.equal(
        field(field(segments[0], "output"), "reason"),
        fits ? undefined : "worker-blocked",
      );
    });
  });

await test("CLV-122 SDK rejects an oversized intact summary from a destination that does not truncate", () =>
  withConsumer(generatedArtifact().source, async (consumer) => {
    const result = await consumer.run(`${generatedPrelude()}
const worker = { ...destination, deliver: async (intent) => {
  const outcome = await destination.deliver(intent);
  return { ...outcome, result: JSON.stringify({ summary: JSON.stringify({ status: "repair", findings: "x".repeat(16001) }) }) };
} };
const service = await openGenerated({ destination: worker });
const runId = await submitGenerated();
await terminal(runId);
print(await generatedState(runId));
await service.close();
`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(field(result.lines[0], "sends"), 1);
    assert.deepEqual(field(result.lines[0], "budget"), { limit: 6, spent: 1 });
    const segments: unknown = field(result.lines[0], "segments");
    assert.ok(Array.isArray(segments));
    assert.equal(
      field(field(segments[0], "output"), "reason"),
      "worker-blocked",
    );
  }));
