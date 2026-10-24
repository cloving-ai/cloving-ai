import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { refusedStart as refused } from "./cli-start-fixture.ts";
import { ended, reached, scene, withoutChildren } from "./self-host-fixture.ts";

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

await test("CLV-084 start refuses the queue without a next-ticket command", async () => {
  for (const command of [undefined, "[]"])
    assert.match(
      await refused({
        CLOVING_QUEUE_SECONDS: "10",
        CLOVING_NEXT_COMMAND: command,
      }),
      /The daemon did not start: queue-needs-next-command/,
    );
});

await test("CLV-084 start refuses the queue without a ticket command", async () => {
  for (const command of [undefined, "[]"])
    assert.match(
      await refused({
        CLOVING_QUEUE_SECONDS: "10",
        CLOVING_NEXT_COMMAND: '["false"]',
        CLOVING_TICKET_COMMAND: command,
      }),
      /The daemon did not start: queue-needs-ticket-command/,
    );
});

await test("CLV-131 start resets the queue journal only with the explicit reset flag", () =>
  withoutChildren(async () => {
    const fixture = await scene();
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
