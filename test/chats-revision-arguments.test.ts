import { readdir } from "node:fs/promises";
import { cli } from "./chats-redact-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";
import { importId } from "./chats-redact-fixture.ts";

await test("CLV-113 parses one previous import and keeps literal arguments", () => {
  for (const selection of [["source"], ["--root", "root"]]) {
    const result = parseInvocation([
      "chats",
      "import",
      "--previous-import",
      importId,
      ...selection,
    ]);
    assert.equal(result.kind, "chats-import");
    assert.ok(
      "previousImportId" in result && result.previousImportId === importId,
    );
  }
  assert.deepEqual(
    parseInvocation(["chats", "import", "--", "--previous-import", importId]),
    {
      kind: "chats-import",
      paths: ["--previous-import", importId],
    },
  );
});

await test("CLV-113 refuses missing, repeated and malformed previous import options", () => {
  for (const [args, code] of [
    [["--previous-import"], "missing-value"],
    [["--previous-import", "--root", "root"], "missing-value"],
    [["--previous-import", "private-invalid", "source"], "invalid-import-id"],
    [
      ["--previous-import", importId, "--previous-import", importId, "source"],
      "repeated-previous-import",
    ],
    [["--previous-import", importId], "missing-argument"],
  ] as const) {
    assert.deepEqual(parseInvocation(["chats", "import", ...args]), {
      kind: "usage-error",
      code,
      json: false,
    });
  }
});

await test("CLV-113 invalid previous options exit 2 with fixed private diagnostics and no output", async () => {
  await withFiles({}, async (directory) => {
    const before = await readdir(directory, { recursive: true });
    for (const args of [
      ["--previous-import"],
      ["--previous-import", "private-invalid", "source"],
      ["--previous-import", importId, "--previous-import", importId, "source"],
    ]) {
      const result = cli(directory, ["chats", "import", ...args]);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /private-invalid|source/);
    }
    assert.deepEqual(await readdir(directory, { recursive: true }), before);
  });
});
