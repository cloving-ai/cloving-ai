import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { proposedWorkerText } from "../../quality/worker-edit.ts";
import { withFiles } from "./files-fixture.ts";

await test("QG-15 reconstructs sequential MultiEdit replacements against the evolving source", async () => {
  await withFiles({ "main.ts": "first first" }, async (directory) => {
    assert.equal(
      await proposedWorkerText(
        {
          event: "PreToolUse",
          tool: "MultiEdit",
          file: "main.ts",
          input: {
            edits: [
              { old_string: "first", new_string: "next", replace_all: true },
              { old_string: "next next", new_string: "last" },
            ],
          },
        },
        join(directory, "main.ts"),
      ),
      "last",
    );
  });
});

await test("QG-15 rejects missing ambiguous and malformed replacement edits", async () => {
  await withFiles({ "main.ts": "first first" }, async (directory) => {
    for (const input of [
      { old_string: "first", new_string: "next" },
      { old_string: "absent", new_string: "next" },
      { old_string: "", new_string: "next" },
      { old_string: "first", new_string: "next", replace_all: "yes" },
    ]) {
      await assert.rejects(
        proposedWorkerText(
          { event: "PreToolUse", tool: "Edit", file: "main.ts", input },
          join(directory, "main.ts"),
        ),
        /ambiguous-worker-edit|invalid-worker-edit/,
      );
    }
  });
});

await test("QG-15 literal Edit replacement preserves dollar replacement tokens", async () => {
  await withFiles({ "main.ts": "original" }, async (directory) => {
    assert.equal(
      await proposedWorkerText(
        {
          event: "PreToolUse",
          tool: "Edit",
          file: "main.ts",
          input: { old_string: "original", new_string: "$&" },
        },
        join(directory, "main.ts"),
      ),
      "$&",
    );
  });
});
