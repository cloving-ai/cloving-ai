import assert from "node:assert/strict";
import { test } from "node:test";
import { refusedStart } from "./cli-start-fixture.ts";

await test("CLV-178 invalid command settings stop daemon startup with fixed codes", async () => {
  for (const [name, value, code] of [
    ["CLOVING_COMMANDS", "invalid JSON", "invalid-commands"],
    ["CLOVING_COMMANDS", '{"scan":["relative-path"]}', "invalid-commands"],
    ["CLOVING_COMMAND_SECONDS", "0", "invalid-command-seconds"],
    ["CLOVING_COMMAND_SECONDS", "3601", "invalid-command-seconds"],
  ] as const)
    assert.match(
      await refusedStart({
        CLOVING_COMMANDS: undefined,
        CLOVING_COMMAND_SECONDS: undefined,
        CLOVING_SELF_UPDATE_SECONDS: undefined,
        [name]: value,
      }),
      new RegExp(code),
    );
});
