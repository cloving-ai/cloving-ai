import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

await test("CLV-227 shared self-development settings contain only merge checks and no workflow copy", async () => {
  assert.deepEqual(JSON.parse(await readFile(".cloving/config.json", "utf8")), {
    version: 1,
    checks: {
      beforeMerge: ["npm", "run", "check:quality"],
      required: ["quality", "quality_linux"],
    },
  });
  await assert.rejects(access(".cloving/workflows"), { code: "ENOENT" });
});
