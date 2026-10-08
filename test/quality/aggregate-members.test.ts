import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectFixture } from "./structure-fixture.ts";

function members(start: number, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `method${String(start + index)}(): void;`,
  ).join("\n");
}

for (const [name, declaration] of [
  [
    "inherited class",
    `class Base { ${members(0, 10).replaceAll(": void;", " {}")} } export class Example extends Base { MEMBERS }`,
  ],
  [
    "named intersection",
    `type Base = { ${members(0, 10)} }; export type Example = Base & { MEMBERS };`,
  ],
  [
    "merged class",
    `class Example { ${members(0, 10).replaceAll(": void;", " {}")} } interface Example { MEMBERS }`,
  ],
  [
    "interface preceding merged class",
    `interface Example { MEMBERS } class Example { ${members(0, 10).replaceAll(": void;", " {}")} }`,
  ],
  [
    "interface preceding merged static class",
    `interface Example { MEMBERS } class Example { ${members(0, 10).replaceAll("method", "static method").replaceAll(": void;", " {}")} }`,
  ],
] as const) {
  await test(`QG-14 24/25 aggregate members for ${name}`, async () => {
    for (const count of [14, 15]) {
      const additional =
        name === "inherited class"
          ? members(10, count).replaceAll(": void;", " {}")
          : members(10, count);
      const findings = await inspectFixture({
        "fixture.ts": declaration.replace("MEMBERS", additional),
      });
      if (count === 14) {
        assert.deepEqual(findings, []);
        continue;
      }
      assert.equal(findings[0]?.rule, "max-type-callables");
      assert.equal(findings[0].measured, 25);
    }
  });
}
