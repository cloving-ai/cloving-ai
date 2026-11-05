import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowBundleLoader } from "../tools/self-host-workflows.ts";
import { queuePrelude } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import {
  bundlePrelude,
  chargedWorkflow,
  generationSettings,
  waitingGeneration,
  queuedGeneration,
  restartedGeneration,
} from "./daemon-bundle-fixture.ts";

function restartScene(environment: Readonly<Record<string, string>>) {
  return withConsumer(chargedWorkflow, async (original) =>
    withConsumer(
      chargedWorkflow.replaceAll("original-", "current-"),
      async (current) => {
        const first = await original.run(
          bundlePrelude +
            generationSettings +
            (environment["GENERATION"] === "queued"
              ? queuedGeneration
              : waitingGeneration),
        );
        assert.equal(first.status, 0, first.stderr);
        const second = await original.run(
          queuePrelude + workflowBundleLoader() + restartedGeneration,
          { CURRENT_PROJECT: current.directory, ...environment },
        );
        assert.equal(second.status, 0, second.stderr);
        return second;
      },
    ),
  );
}

for (const generation of ["edited", "removed", "queued"]) {
  await test(`CLV-162 a process restart with ${generation} project workflow retains code, duplicate answers, replay and spending`, async () => {
    await restartScene({ GENERATION: generation });
  });
}

await test("CLV-295 the start sweep deletes an old free bundle and keeps the bundle of a waiting run, which then completes", async () => {
  const second = await restartScene({
    GENERATION: "edited",
    RETENTION: "delete",
  });
  assert.match(
    second.stderr,
    /^retention: deleted workflow bundle [a-f0-9]{64}$/m,
  );
});
