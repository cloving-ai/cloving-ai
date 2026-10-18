import assert from "node:assert/strict";
import { test } from "node:test";
import { lockRequiresInstall } from "../tools/self-update.ts";

await test("CLV-109 root package and top-level metadata changes need no install", () => {
  const installed = {
    "node_modules/@workflow/builders": { version: "5.0.2" },
  };
  const before = JSON.stringify({
    name: "cloving",
    version: "1.0.0",
    packages: {
      "": {
        version: "1.0.0",
        devDependencies: { "@workflow/builders": "5.0.2" },
      },
      ...installed,
    },
  });
  const after = JSON.stringify({
    name: "renamed",
    version: "1.0.1",
    packages: {
      "": {
        version: "1.0.1",
        engines: { node: ">=26.9.0 <27" },
        dependencies: { "@workflow/builders": "5.0.2" },
      },
      ...installed,
    },
  });
  assert.equal(lockRequiresInstall(before, after), false);
});

await test("CLV-109 changed, added and removed installed packages need an install", () => {
  const before = JSON.stringify({
    packages: { "node_modules/example": { version: "1.0.0" } },
  });
  for (const packages of [
    { "node_modules/example": { version: "2.0.0" } },
    {
      "node_modules/example": { version: "1.0.0" },
      "node_modules/added": { version: "1.0.0" },
    },
    {},
  ]) {
    const after = JSON.stringify({ packages });
    assert.equal(lockRequiresInstall(before, after), true);
    assert.equal(lockRequiresInstall(after, before), true);
  }
});

await test("CLV-109 lock comparison ignores object key order and formatting", () => {
  const before =
    '{"packages":{"node_modules/a":{"version":"1","integrity":"sha512-a"},"node_modules/b":{"version":"2"}}}';
  const after = JSON.stringify(
    {
      packages: {
        "node_modules/b": { version: "2" },
        "node_modules/a": { integrity: "sha512-a", version: "1" },
      },
    },
    null,
    2,
  );
  assert.equal(lockRequiresInstall(before, after), false);
});

await test("CLV-109 invalid JSON and missing package objects require an install", () => {
  const valid = JSON.stringify({ packages: {} });
  for (const invalid of [
    "{",
    "",
    "null",
    "[]",
    "{}",
    '{"packages":null}',
    '{"packages":[]}',
    '{"packages":"invalid"}',
  ]) {
    assert.equal(lockRequiresInstall(valid, invalid), true, invalid);
    assert.equal(lockRequiresInstall(invalid, valid), true, invalid);
  }
});
