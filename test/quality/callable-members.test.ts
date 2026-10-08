import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectFixture } from "./structure-fixture.ts";

function methods(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `method${String(index)}(): void;`,
  ).join("\n");
}

await test("QG-14 interface ten/eleven callable-member boundary includes properties", async () => {
  const allowed = await inspectFixture({
    "fixture.ts": `export interface Example { ${methods(10)} }`,
  });
  assert.deepEqual(allowed, []);
  const exceeded = await inspectFixture({
    "fixture.ts": `export interface Example { ${methods(10)} extra: () => void; }`,
  });
  assert.equal(exceeded[0]?.rule, "max-interface-callables");
  assert.equal(exceeded[0].measured, 11);
});

await test("QG-14 merged interface members are counted across files once", async () => {
  const findings = await inspectFixture({
    "first.ts": `interface Example { ${methods(10)} }`,
    "second.ts": "interface Example { extra(): void; }",
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.measured, 11);
});

await test("QG-14 inherited interface members count toward the limit", async () => {
  const findings = await inspectFixture({
    "fixture.ts": `interface Base { ${methods(10)} } export interface Example extends Base { extra(): void; }`,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.measured, 11);
});

for (const kind of ["class", "type"]) {
  await test(`QG-14 ${kind} 24/25 callable-member boundary`, async () => {
    const members =
      kind === "class" ? methods(24).replaceAll(": void;", " {}") : methods(24);
    const declaration =
      kind === "class"
        ? `export class Example { ${members} }`
        : `export type Example = { ${members} };`;
    assert.deepEqual(await inspectFixture({ "fixture.ts": declaration }), []);
    const extra = kind === "class" ? "extra = () => {};" : "extra: () => void;";
    const exceeded = declaration.replace(
      kind === "class" ? / }$/ : / };$/,
      `${extra} }`,
    );
    const findings = await inspectFixture({ "fixture.ts": exceeded });
    assert.equal(findings[0]?.rule, "max-type-callables");
    assert.equal(findings[0].measured, 25);
  });
}
