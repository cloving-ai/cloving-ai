import assert from "node:assert/strict";
import { test } from "node:test";
import { refusedStart as refused } from "./cli-start-fixture.ts";

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
