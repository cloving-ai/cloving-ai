import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { refusedStart as refused } from "./cli-start-fixture.ts";
import { ended, reached, scene, withoutChildren } from "./self-host-fixture.ts";
import { call } from "./service-fixture.ts";
import { writeQueueWorkflow } from "./workflow-folder-fixture.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";

const entry = join(candidatePackageRoot, "src/cli.ts");

await test("CLV-228 a queue interval without a declared queue workflow starts no queue", () =>
  withoutChildren(async () => {
    const fixture = await scene();
    const daemon = await fixture.start({
      CLOVING_QUEUE_SECONDS: "10",
      CLOVING_QUEUE_LANES: undefined,
      CLOVING_NEXT_COMMAND: JSON.stringify([
        process.execPath,
        "-e",
        'console.log("CLV-900")',
      ]),
      CLOVING_SELF_UPDATE_SECONDS: undefined,
    });
    try {
      const status = await call(fixture, {
        operation: "status",
        parameters: {},
      });
      assert.equal(status["queue"], undefined, JSON.stringify(status));
      assert.deepEqual(status["runs"], []);
    } finally {
      assert.equal(await ended(daemon), 0);
    }
    await assert.rejects(
      readFile(join(fixture.directory, "queue-commands.json")),
      {
        code: "ENOENT",
      },
    );
  }));

await test("CLV-184 queue lanes require a queue and a whole number from one to four", async () => {
  for (const value of ["0", "5", "2.5", "", "NaN", "1e0", "-1"])
    assert.match(
      await refused({ CLOVING_QUEUE_LANES: value }),
      /invalid-queue-lanes/,
    );
  assert.match(
    await refused({
      CLOVING_QUEUE_LANES: "2",
      CLOVING_QUEUE_SECONDS: undefined,
    }),
    /queue-lanes-needs-queue/,
  );
});

await test("CLV-084 start refuses a queue interval outside its whole second bounds", async () => {
  for (const value of ["5", "3601", "10.5", "", "NaN", "1e2"])
    assert.match(
      await refused({ CLOVING_QUEUE_SECONDS: value }),
      /The daemon did not start: invalid-queue-seconds/,
    );
});

await test("CLV-084 start refuses a declared queue without a next-ticket command", async () => {
  for (const command of [undefined, "[]"])
    assert.match(
      await refused(
        {
          CLOVING_QUEUE_SECONDS: "10",
          CLOVING_NEXT_COMMAND: command,
        },
        { queue: true, entry },
      ),
      /The daemon did not start: queue-needs-next-command/,
    );
});

await test("CLV-084 start refuses a declared queue without a ticket command", async () => {
  for (const command of [undefined, "[]"])
    assert.match(
      await refused(
        {
          CLOVING_QUEUE_SECONDS: "10",
          CLOVING_NEXT_COMMAND: '["false"]',
          CLOVING_TICKET_COMMAND: command,
        },
        { queue: true, entry },
      ),
      /The daemon did not start: queue-needs-ticket-command/,
    );
});

await test("CLV-131 start resets the queue journal only with the explicit reset flag", () =>
  withoutChildren(async () => {
    const fixture = await scene(undefined, entry);
    await writeQueueWorkflow(join(fixture.repository, ".cloving/workflows"));
    await mkdir(fixture.directory, { recursive: true });
    const file = join(fixture.directory, "queue-commands.json");
    const prior = JSON.stringify({
      commands: [],
      failures: ["run-first", "run-second", "run-third"],
    });
    await writeFile(file, prior);
    const environment = {
      CLOVING_QUEUE_SECONDS: "10",
      CLOVING_NEXT_COMMAND: '["false"]',
    };
    const ordinary = await fixture.start(environment);
    assert.equal(await readFile(file, "utf8"), prior);
    assert.equal(await ended(ordinary), 0);
    const reset = await fixture.start(environment, ["--reset-queue"]);
    try {
      await reached(async () =>
        (await readFile(file, "utf8")) === '{"commands":[],"failures":[]}\n'
          ? true
          : undefined,
      );
      assert.equal(
        await readFile(file, "utf8"),
        '{"commands":[],"failures":[]}\n',
      );
    } finally {
      assert.equal(await ended(reset), 0);
    }
  }));

await test("CLV-241 daily spend limit must be positive and finite and needs a queue", async () => {
  for (const value of ["0", "-1", "text", "Infinity", "1e999", "", "NaN"])
    assert.match(
      await refused({ CLOVING_QUEUE_DAILY_SPEND_USD: value }),
      /invalid-queue-spend-limit/,
    );
  assert.match(
    await refused({
      CLOVING_QUEUE_DAILY_SPEND_USD: "20",
      CLOVING_QUEUE_SECONDS: undefined,
    }),
    /queue-spend-limit-needs-queue/,
  );
});
