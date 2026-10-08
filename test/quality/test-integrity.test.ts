import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectTestIntegrity } from "../../quality/test-integrity.ts";
import { withProgram } from "./program-fixture.ts";

for (const body of [
  'await test.only("focused", () => {});',
  'await test("conditional", { skip: true }, () => {});',
  'const focused = test.only; await focused("alias", () => {});',
  'await test("skip", (context) => { context.skip(); });',
]) {
  await test(`QG-18 rejects focused or disabled test API: ${body}`, async () => {
    await withProgram(
      { "main.test.ts": `import { test } from "node:test"; ${body}` },
      (program) => {
        assert.ok(
          inspectTestIntegrity(program).some((finding) =>
            finding.includes("test-selection"),
          ),
        );
      },
    );
  });
}

await test("QG-18 rejects an assertion alias whose explicit type hides the original API", async () => {
  await withProgram(
    {
      "main.test.ts":
        'import assert from "node:assert/strict"; import { test } from "node:test"; const verify: (value: Promise<unknown>) => Promise<void> = assert.rejects; await test("detached", () => { verify(Promise.resolve()).catch(() => {}); });',
    },
    (program) => {
      assert.ok(
        inspectTestIntegrity(program).some((finding) =>
          finding.includes("test-api-escape"),
        ),
      );
    },
  );
});

for (const [name, source, rule] of [
  [
    "early conditional return",
    'import assert from "node:assert/strict"; import { test } from "node:test"; await test("hidden", () => { if (!process.env["OPTIONAL"]) return; assert.fail("not executed"); });',
    "conditional-test-exit",
  ],
  [
    "assertion namespace escape",
    'import * as assertions from "node:assert/strict"; import { test } from "node:test"; const facade: { rejects: (value: Promise<unknown>) => Promise<void> } = assertions; await test("detached", () => { facade.rejects(Promise.resolve()).catch(() => {}); });',
    "test-api-escape",
  ],
] as const) {
  await test(`QG-18 rejects ${name}`, async () => {
    await withProgram({ "main.test.ts": source }, (program) => {
      assert.ok(
        inspectTestIntegrity(program).some((finding) => finding.includes(rule)),
      );
    });
  });
}

await test("QG-18 rejects handled but detached asynchronous assertions", async () => {
  await withProgram(
    {
      "main.test.ts":
        'import assert from "node:assert/strict"; import { test } from "node:test"; await test("detached", () => { assert.rejects(Promise.resolve()).catch(() => {}); });',
    },
    (program) => {
      assert.ok(
        inspectTestIntegrity(program).some((finding) =>
          finding.includes("unawaited-assertion"),
        ),
      );
    },
  );
});

await test("QG-18 accepts awaited assertions and unrelated selection-shaped data", async () => {
  await withProgram(
    {
      "main.test.ts":
        'import assert from "node:assert/strict"; import { test } from "node:test"; await test("valid", async () => { const data = { skip: true }; assert.ok(data.skip); await assert.rejects(Promise.reject(new Error("expected"))); });',
    },
    (program) => {
      assert.deepEqual(inspectTestIntegrity(program), []);
    },
  );
});

for (const body of [
  'if (process.env["OPTIONAL"]) await test("hidden", () => { assert.ok(true); });',
  'await test("conditional assertion", () => { if (process.env["OPTIONAL"]) assert.ok(false); });',
  'await test("logical assertion", () => { process.env["OPTIONAL"] && assert.ok(false); });',
]) {
  await test(`QG-18 rejects conditional test evidence: ${body}`, async () => {
    await withProgram(
      {
        "main.test.ts": `import assert from "node:assert/strict"; import { test } from "node:test"; ${body}`,
      },
      (program) => {
        assert.ok(
          inspectTestIntegrity(program).some((finding) =>
            finding.includes("conditional-test-evidence"),
          ),
        );
      },
    );
  });
}
