import assert from "node:assert/strict";
import { test } from "node:test";
import { saveAnalysisFiles } from "../src/daemon/chats-files.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { withAnalysis, cycleId } from "./chats-worker-fixture.ts";

for (const character of ["x", "é", "😀", '"', "\\"]) {
  await test(
    `CLV-119 bounds the complete escaped saved output for ${character}`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        const output = { cycleId, analysis: "", proposal: "" };
        const initial = Buffer.byteLength(JSON.stringify(output));
        const unit = Buffer.byteLength(JSON.stringify(character)) - 2;
        const remaining = 65_536 - initial;
        output.analysis =
          character.repeat(Math.floor(remaining / unit)) +
          "x".repeat(remaining % unit);
        assert.equal(Buffer.byteLength(JSON.stringify(output)), 65_536);
        const before = await fixture.files();
        await assert.rejects(
          saveAnalysisFiles(fixture.directory, { ...output, proposal: "x" }),
          { message: "analysis-too-large" },
        );
        assert.deepEqual(await fixture.files(), before);
        await saveAnalysisFiles(fixture.directory, output);
        await saveAnalysisFiles(fixture.directory, output);
      });
    }),
  );
}
