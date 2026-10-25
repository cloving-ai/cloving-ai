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

for (const generation of ["edited", "removed", "queued"]) {
  await test(`CLV-162 a process restart with ${generation} project workflow retains code, duplicate answers, replay and spending`, () =>
    withConsumer(chargedWorkflow, async (original) =>
      withConsumer(
        chargedWorkflow.replaceAll("original-", "current-"),
        async (current) => {
          const first = await original.run(
            bundlePrelude +
              generationSettings +
              (generation === "queued" ? queuedGeneration : waitingGeneration),
          );
          assert.equal(first.status, 0, first.stderr);
          const second = await original.run(
            queuePrelude + workflowBundleLoader() + restartedGeneration,
            { CURRENT_PROJECT: current.directory, GENERATION: generation },
          );
          assert.equal(second.status, 0, second.stderr);
        },
      ),
    ));
}
