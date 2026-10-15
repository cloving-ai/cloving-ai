import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { withHarness } from "./service-fixture.ts";

async function refused(
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
  return withHarness((harness) => {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../src/cli.ts"), "start"],
      {
        cwd: harness.projectDirectory,
        env: {
          ...process.env,
          CLOVING_RUNTIME_DIR: harness.runtimeDirectory,
          CLOVING_WATCH_PORT: "off",
          ...environment,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    return Promise.resolve(result.stderr);
  });
}

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

await test("CLV-085 start refuses self-update intervals outside whole second bounds", async () => {
  for (const value of ["10", "3601", "30.5", "", "NaN", "3e2"])
    assert.match(
      await refused({ CLOVING_SELF_UPDATE_SECONDS: value }),
      /invalid-self-update-seconds/,
    );
});

await test("CLV-085 self-update requires the checkout of the running code", async () => {
  assert.match(
    await refused({ CLOVING_SELF_UPDATE_SECONDS: "120" }),
    /self-update-needs-own-repository/,
  );
});
