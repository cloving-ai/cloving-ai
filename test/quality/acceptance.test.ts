import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { consumeAcceptance } from "../../quality/acceptance.ts";
import { executeVerification } from "../../quality/verification.ts";
import { snapshotTree } from "../../quality/tree-snapshot.ts";
import {
  acceptancePlan,
  packArchive,
  withAcceptance,
} from "./acceptance-fixture.ts";

await test("QG-11 consumption accepts current evidence and rejects a file added after the pass", async () => {
  await withAcceptance({}, async (fixture) => {
    const verdict = await consumeAcceptance(fixture.state, fixture);
    assert.equal(verdict.verdict, "accepted");
    assert.equal(verdict.plan, acceptancePlan.identity);
    assert.equal(verdict.candidate, fixture.evidence.candidate);
    await writeFile(join(fixture.candidate, "src/added.ts"), "export {};");
    await assert.rejects(
      consumeAcceptance(fixture.state, fixture),
      /stale-acceptance-candidate/,
    );
  });
});

await test("QG-10 skipped static checks, failed exits and candidate entries cannot produce acceptance", async () => {
  await withAcceptance({}, async (fixture) => {
    const { static: checked } = fixture.evidence;
    for (const [changed, expected] of [
      [
        {
          execution: {
            ...checked.execution,
            stdout: JSON.stringify({
              kind: "static-analysis",
              completed: ["inventory"],
            }),
          },
        },
        /missing-required-static-check/,
      ],
      [
        { execution: { ...checked.execution, stdout: "accepted" } },
        /missing-required-static-check/,
      ],
      [{ execution: { ...checked.execution, exit: 1 } }, /static-check-failed/],
      [
        { execution: { ...checked.execution, signal: "SIGKILL" } },
        /static-check-failed/,
      ],
      [
        {
          command: {
            ...checked.command,
            arguments: [join(fixture.candidate, "check.ts"), fixture.candidate],
          },
        },
        /untrusted-static-command/,
      ],
      [{ verifier: "candidate-verifier" }, /untrusted-static-command/],
    ] as const)
      await assert.rejects(
        consumeAcceptance(fixture.state, {
          candidate: fixture.candidate,
          evidence: { ...fixture.evidence, static: { ...checked, ...changed } },
        }),
        expected,
      );
  });
});

await test("QG-11 diagnostics need an intact passing receipt above the independent test floor", async () => {
  for (const [tests, expected] of [
    [
      'import { test } from "node:test";\ntest("only", () => {});\n',
      /insufficient-diagnostic-tests/,
    ],
    [
      'import { test } from "node:test";\ntest("first", () => {});\ntest("second", () => {});\ntest.skip("skipped", () => {});\n',
      /insufficient-diagnostic-tests/,
    ],
    [
      'import { test } from "node:test";\ntest("first", () => {});\ntest("second", () => { throw new Error("failed"); });\n',
      /verification-failed/,
    ],
  ] as const)
    await withAcceptance({ tests }, async (fixture) => {
      await assert.rejects(consumeAcceptance(fixture.state, fixture), expected);
    });
  await withAcceptance({}, async (fixture) => {
    const { diagnostics } = fixture.evidence;
    await assert.rejects(
      consumeAcceptance(fixture.state, {
        candidate: fixture.candidate,
        evidence: {
          ...fixture.evidence,
          diagnostics: { ...diagnostics, executions: [] },
        },
      }),
      /invalid-verification-receipt/,
    );
  });
});

await test("QG-11 diagnostics must run the fixed command over the complete current inventory", async () => {
  await withAcceptance({}, async (fixture) => {
    for (const command of [
      { ...fixture.command, arguments: fixture.command.arguments.slice(1) },
      { ...fixture.command, directory: fixture.root },
    ]) {
      const diagnostics = await executeVerification(
        { requiredChecks: ["diagnostics"], commands: [command] },
        fixture.inventory,
      );
      await assert.rejects(
        consumeAcceptance(fixture.state, {
          candidate: fixture.candidate,
          evidence: { ...fixture.evidence, diagnostics },
        }),
        /untrusted-diagnostic-command/,
      );
    }
    for (const [file, expected] of [
      ["src/added.ts", /incomplete-diagnostic-inventory/],
      ["test/added.test.ts", /untrusted-diagnostic-command/],
    ] as const) {
      await writeFile(join(fixture.candidate, file), "export {};");
      const tree = (await snapshotTree(fixture.candidate)).identity;
      await assert.rejects(
        consumeAcceptance(fixture.state, {
          candidate: fixture.candidate,
          evidence: {
            ...fixture.evidence,
            candidate: tree,
            static: { ...fixture.evidence.static, candidate: tree },
            scenarios: fixture.evidence.scenarios.map((scenario) => ({
              ...scenario,
              candidate: tree,
            })),
          },
        }),
        expected,
      );
    }
  });
});

await test("QG-10 each controller scenario must pass once for the active verifier and current candidate", async () => {
  await withAcceptance({}, async (fixture) => {
    const [first, second] = fixture.evidence.scenarios;
    assert.ok(first && second);
    for (const [scenarios, expected] of [
      [[first], /missing-controller-scenario/],
      [
        [first, { ...second, outcome: "failed" }],
        /missing-controller-scenario/,
      ],
      [
        [first, second, { ...second, outcome: "failed" }],
        /missing-controller-scenario/,
      ],
      [[first, { ...second, verifier: "older" }], /stale-controller-scenario/],
      [[first, { ...second, candidate: "older" }], /stale-controller-scenario/],
    ] as const)
      await assert.rejects(
        consumeAcceptance(fixture.state, {
          candidate: fixture.candidate,
          evidence: { ...fixture.evidence, scenarios },
        }),
        expected,
      );
  });
});

await test("QG-11 artifacts must be current and bound to the candidate and their checks", async () => {
  await withAcceptance({}, async (fixture) => {
    const [output, packed, handlers] = fixture.evidence.artifacts;
    assert.ok(output && packed && handlers);
    const older = join(fixture.root, "older.tgz");
    const olderDigest = await packArchive(older, {
      "package.json": '{"name":"older"}',
    });
    for (const [artifacts, expected] of [
      [[output, packed], /missing-acceptance-artifact/],
      [
        [output, { ...packed, path: older, digest: olderDigest }, handlers],
        /unbound-acceptance-artifact: package-tarball/,
      ],
      [
        [{ ...handlers, name: "typescript-output" }, packed, handlers],
        /unbound-acceptance-artifact: typescript-output/,
      ],
      [
        [output, packed, { ...handlers, regenerated: handlers.path }],
        /unbound-acceptance-artifact: workflow-handlers/,
      ],
    ] as const)
      await assert.rejects(
        consumeAcceptance(fixture.state, {
          candidate: fixture.candidate,
          evidence: { ...fixture.evidence, artifacts },
        }),
        expected,
      );
    await writeFile(join(fixture.root, "artifacts/handlers/steps.mjs"), "");
    await assert.rejects(
      consumeAcceptance(fixture.state, fixture),
      /stale-acceptance-artifact: workflow-handlers/,
    );
  });
  await withAcceptance({}, async (fixture) => {
    await writeFile(join(fixture.root, "artifacts/package.tgz"), "changed");
    await assert.rejects(
      consumeAcceptance(fixture.state, fixture),
      /stale-acceptance-artifact: package-tarball/,
    );
  });
  await withAcceptance(
    { source: '"use workflow";\nexport const value = 1;' },
    async (fixture) => {
      await assert.rejects(
        consumeAcceptance(fixture.state, fixture),
        /unbound-acceptance-artifact: workflow-handlers/,
      );
    },
  );
});

await test("QG-12 consumption requires the active verifier outside the candidate", async () => {
  await withAcceptance({}, async (fixture) => {
    await assert.rejects(
      consumeAcceptance(fixture.root, fixture),
      /overlapping-acceptance-state/,
    );
    await writeFile(
      join(fixture.installed.directory, "tools/check-protected-quality.ts"),
      "process.exit(0);",
    );
    await assert.rejects(
      consumeAcceptance(fixture.state, fixture),
      /verifier-installation-changed/,
    );
  });
});

const productStep =
  'export async function loadCycle(input: { cycleId: string }) {\n  "use step";\n  return input;\n}\n';
const productStepId =
  "step//fixture/workflows/steps/load-cycle@1.0.0//loadCycle";
const productPackage = (exports: unknown): string =>
  JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    type: "module",
    exports,
  });
const stepExport = {
  "./workflows/steps/load-cycle": {
    types: "./dist/src/steps/load-cycle.d.ts",
    import: "./dist/src/steps/load-cycle.js",
  },
};

await test("QG-11 product step helpers bind to the regenerated handler manifest by their versioned export identity", async () => {
  const product = {
    files: { "src/steps/load-cycle.ts": productStep },
    packageJson: productPackage(stepExport),
    manifestSteps: { loadCycle: productStepId },
  };
  await withAcceptance(product, async (fixture) => {
    const verdict = await consumeAcceptance(fixture.state, fixture);
    assert.equal(verdict.verdict, "accepted");
  });
  for (const changed of [
    { ...product, contractSteps: [] },
    { ...product, packageJson: productPackage({}) },
    { ...product, files: { "src/helper.ts": productStep } },
    { ...product, files: { "src/steps/nested/load-cycle.ts": productStep } },
  ])
    await withAcceptance(changed, async (fixture) => {
      await assert.rejects(
        consumeAcceptance(fixture.state, fixture),
        /unbound-acceptance-artifact: workflow-handlers/,
      );
    });
});
