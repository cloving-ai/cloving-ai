import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { restartSettings } from "../tools/restart-settings.ts";
import {
  queueScene,
  startOutput,
  statusOf,
  workflowFile,
} from "./cli-start-declared-queue-fixture.ts";

await test("CLV-373 the v1.9 declared queue stays dormant through service startup and restart without an interval", async () => {
  const { fixture, environment } = await queueScene({ queue: true });
  const selected = join(fixture.root, "selected");
  const retainedJournal = join(fixture.directory, "queue-commands.json");
  await mkdir(fixture.directory, { recursive: true });
  await writeFile(retainedJournal, "retained legacy journal");
  await writeFile(
    join(fixture.root, "next.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(selected)}, "selected");
process.stdout.write("CLV-900");`,
  );
  for (const queues of [undefined, "{}", '{"other":{}}']) {
    await startOutput(fixture, {
      environment: {
        ...environment,
        CLOVING_QUEUES: queues,
        CLOVING_QUEUE_MAX_LOAD_PER_CORE: undefined,
        CLOVING_QUEUE_MAX_MEMORY_PRESSURE: undefined,
      },
      inspect: async () => {
        const status = statusOf(fixture);
        const queue = record(status["queue"]);
        assert.equal(queue?.["nextCheckAt"], null);
        assert.equal(queue["settings"], undefined);
        assert.deepEqual(status["runs"], []);
        assert.equal(existsSync(join(fixture.directory, "queues")), false);
        assert.equal(existsSync(selected), false);
        assert.equal(
          await readFile(retainedJournal, "utf8"),
          "retained legacy journal",
        );
      },
    });
  }
});

await test("CLV-373 restart validation accepts shared settings when a dormant legacy queue precedes an active queue", async () => {
  const { fixture, environment } = await queueScene({ queue: true });
  await workflowFile(join(fixture.repository, ".cloving/workflows"), {
    name: "modern",
    fields: { ticket: { type: "ticket" } },
    queue: {},
  });
  const validate = restartSettings({
    repository: fixture.repository,
    fileVariables: [],
    environment: {
      ...environment,
      XDG_CONFIG_HOME: join(fixture.root, "config"),
      CLOVING_QUEUE_LANES: "2",
      CLOVING_READY_COMMAND: '["true"]',
    },
  });
  assert.equal(
    await validate({
      at: "keep",
      commandId: "mixed-queues",
      requestedAt: 1,
      resumeQueue: false,
    }),
    undefined,
  );
});

await test("CLV-373 explicit v1.9 file and environment intervals still start the legacy queue", async () => {
  const { fixture, environment } = await queueScene({ queue: true });
  await writeFile(
    join(fixture.repository, ".cloving/config.json"),
    JSON.stringify({ version: 1, queue: { everySeconds: 60 } }),
  );
  for (const seconds of [undefined, "30"]) {
    await startOutput(fixture, {
      environment: { ...environment, CLOVING_QUEUE_SECONDS: seconds },
      inspect: () => {
        const queue = record(statusOf(fixture)["queue"]);
        assert.equal(queue?.["state"], "running");
        assert.deepEqual(record(queue["settings"])?.["everySeconds"], {
          value: seconds === undefined ? 60 : 30,
          source: seconds === undefined ? "queue setting" : "environment",
        });
      },
    });
  }
});
