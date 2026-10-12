import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
  withChild,
} from "./authority-store-fixture.ts";

after(removeTemporaryDirectories);

await test("CLV-049 the timer of the resolver limit stops when the resolver answers: a process that calls the submission handler with a limit of one hour ends with code 0", async () => {
  const directory = await temporaryDirectory();
  await withChild(
    { script: "resolver-child.ts", parameters: [directory] },
    async (child) => {
      await child.waitFor("replied terminal-run");
      const ended = await Promise.race([
        child.exited,
        delay(10_000, "the process stays alive", { ref: false }),
      ]);
      assert.deepEqual(ended, { code: 0, signal: null });
    },
  );
});
