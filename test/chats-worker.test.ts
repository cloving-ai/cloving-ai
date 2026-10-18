import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { candidate, records, structure } from "./chats-analysis-fixture.ts";
import { validateAnalysis } from "../src/chats/analysis.ts";
import { analysisProposal } from "../src/chats/analysis-proposal.ts";
import { withAnalysis, importId, cycleId } from "./chats-worker-fixture.ts";

await test("CLV-115 saves the accepted fake reply and a private deterministic proposal", async () => {
  await withAnalysis(async (fixture) => {
    await fixture.prepare();
    const saved = await fixture.deliver("save-analysis");
    assert.equal(saved.kind, "completed");
    assert.ok("result" in saved && typeof saved.result === "string");
    const receipt: unknown = JSON.parse(saved.result);
    assert.deepEqual(receipt, {
      kind: "handoff_requested",
      cycleId,
      promotionId: `analysis:${importId}:${cycleId}`,
    });
    const validation = validateAnalysis(candidate(), { records, structure });
    assert.ok(validation.accepted);
    const analysis = join(fixture.directory, `analysis-${cycleId}.json`);
    const result: unknown = JSON.parse(await readFile(analysis, "utf8"));
    assert.deepEqual(result, validation.result);
    const proposal = join(fixture.directory, `proposal-${cycleId}.txt`);
    const text = await readFile(proposal, "utf8");
    assert.equal(text, analysisProposal(validation.result));
    assert.ok(text.length <= 4_000);
    assert.match(text, /unknown/);
    assert.match(text, /not-established/);
    assert.match(text, /Input candidate-input: Candidate changes\./);
    assert.match(text, /Branch review -> repair: Defect found\./);
    assert.match(text, /synthetic:1/);
    assert.equal((await stat(analysis)).mode & 0o777, 0o600);
    assert.equal((await stat(proposal)).mode & 0o777, 0o600);
    assert.equal((await stat(fixture.directory)).mode & 0o777, 0o700);
  });
});
