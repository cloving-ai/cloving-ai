import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { RestartMark } from "../src/restart-request.ts";
import { restartSettings } from "../tools/restart-settings.ts";
import { settingsScene } from "./project-settings-fixture.ts";

const mark: RestartMark = {
  at: "keep",
  requestedAt: 1,
  commandId: "restart-queue",
  resumeQueue: false,
};

await test("CLV-352 a combined queue refusal names working lanes when both lane settings change", async () => {
  const fixture = settingsScene();
  try {
    const validate = restartSettings({
      repository: fixture.repository,
      environment: {
        ...fixture.environment,
        CLOVING_QUEUE_SECONDS: "10",
        CLOVING_QUEUE_LANES: "8",
        CLOVING_QUEUE_WORKING_LANES: "8",
      },
      fileVariables: [],
    });
    const refusal = await validate({
      ...mark,
      variables: { CLOVING_QUEUE_LANES: "8", CLOVING_QUEUE_WORKING_LANES: "9" },
    });
    assert.equal(refusal?.key, "queue.workingLanes");
    assert.match(refusal.detail, /invalid-queue-working-lanes/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

await test("CLV-352 restart validation reads current files without treating file-injected variables as start overrides", async () => {
  const fixture = settingsScene();
  try {
    const validate = restartSettings({
      repository: fixture.repository,
      environment: {
        ...fixture.environment,
        CLOVING_QUEUE_SECONDS: "10",
        CLOVING_QUEUE_LANES: "8",
        CLOVING_QUEUE_WORKING_LANES: "8",
      },
      fileVariables: ["CLOVING_QUEUE_LANES", "CLOVING_QUEUE_WORKING_LANES"],
    });
    fixture.write(fixture.project, {
      version: 1,
      queue: { everySeconds: 10, lanes: 4, workingLanes: 3 },
    });
    assert.equal(await validate(mark), undefined);
    fixture.write(fixture.privateFile, {
      version: 1,
      queue: { workingLanes: 5 },
    });
    assert.match(
      String((await validate(mark))?.detail),
      /invalid-queue-working-lanes/,
    );
    assert.equal(
      await validate({ ...mark, variables: { CLOVING_QUEUE_LANES: "6" } }),
      undefined,
    );
    assert.equal(
      await validate({
        ...mark,
        settings: "files",
        variables: { CLOVING_QUEUE_LANES: "6" },
      }),
      undefined,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
