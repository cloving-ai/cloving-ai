import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectTestIntegrity } from "../../quality/test-integrity.ts";
import { withProgram } from "./program-fixture.ts";

await test("CLV-174 permits the explicit launcher with the complete files and isolation options", async () => {
  await withProgram(
    {
      "quality/test-runner.ts":
        'import { run } from "node:test"; run({ files: ["fixture.test.ts"], concurrency: 2, isolation: "process" }).on("test:summary", () => {});',
    },
    (program) => {
      const runnerFile = program.getRootFileNames()[0];
      assert.ok(runnerFile);
      assert.deepEqual(inspectTestIntegrity(program, { runnerFile }), []);
      assert.ok(
        inspectTestIntegrity(program).some((finding) =>
          finding.includes("test-selection"),
        ),
      );
    },
  );
});

await test("CLV-174 the launcher allowance still rejects filters, focus, discovery and other files", async () => {
  await withProgram(
    {
      "quality/test-runner.ts":
        'import { run, test } from "node:test"; run({ files: ["fixture"], concurrency: 2, isolation: "process", only: true }); run({ files: ["fixture"], concurrency: 2, isolation: "process", testNamePatterns: "limited" }); run({ concurrency: 2, isolation: "process" }); await test.only("focused", () => {});',
      "other.test.ts":
        'import { run } from "node:test"; run({ files: ["fixture"], concurrency: 2, isolation: "process" });',
    },
    (program) => {
      const runnerFile = program
        .getRootFileNames()
        .find((file) => file.endsWith("/quality/test-runner.ts"));
      assert.ok(runnerFile);
      const findings = inspectTestIntegrity(program, { runnerFile });
      assert.equal(findings.length, 5);
      assert.ok(
        findings.every((finding) => finding.startsWith("test-selection:")),
      );
    },
  );
});

for (const body of [
  'const selected = { files: ["fixture"], concurrency: 2, isolation: "process" as const, only: true }; const options: { files: string[]; concurrency: number; isolation: "process" } = selected; run(options);',
  'run({ files: ["fixture"], concurrency: 2, isolation: "none" });',
  'const options = { files: ["fixture"], concurrency: 2, isolation: "process" as const }; run({ ...options });',
  'run({ ["files"]: ["fixture"], concurrency: 2, isolation: "process" });',
  'run({ get files() { return ["fixture"]; }, concurrency: 2, isolation: "process" });',
])
  await test(`CLV-174 rejects indirect or unisolated runner options: ${body}`, async () => {
    await withProgram(
      { "quality/test-runner.ts": `import { run } from "node:test"; ${body}` },
      (program) => {
        const runnerFile = program.getRootFileNames()[0];
        assert.ok(runnerFile);
        assert.ok(
          inspectTestIntegrity(program, { runnerFile }).some((finding) =>
            finding.includes("test-selection"),
          ),
        );
      },
    );
  });

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
