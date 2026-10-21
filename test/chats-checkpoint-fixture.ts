import { join } from "node:path";
import {
  captureAnalysisSnapshot,
  type AnalysisCapture,
} from "../src/daemon/chats-capture.ts";
import { saveAnalysisCheckpoint } from "../src/daemon/chats-checkpoints.ts";
import { withAnalysis, importId, cycleId } from "./chats-worker-fixture.ts";

type BatchInput = Omit<Parameters<typeof saveAnalysisCheckpoint>[1], "capture">;
type CheckpointFixture = Omit<
  Parameters<Parameters<typeof withAnalysis>[0]>[0],
  "capture"
> & {
  readonly capture: AnalysisCapture;
  readonly folder: string;
  readonly save: (
    input: BatchInput,
  ) => ReturnType<typeof saveAnalysisCheckpoint>;
};

export async function withCheckpoints(
  run: (fixture: CheckpointFixture) => Promise<void>,
): Promise<void> {
  await withAnalysis(async (fixture) => {
    const capture = await captureAnalysisSnapshot(fixture.directory, {
      runId: cycleId,
      importId,
    });
    await run({
      ...fixture,
      capture,
      folder: join(fixture.directory, `capture-${capture.key}`),
      save: (input) =>
        saveAnalysisCheckpoint(fixture.directory, { ...input, capture }),
    });
  });
}
