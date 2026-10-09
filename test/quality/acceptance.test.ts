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
    const verdict = await consumeAcceptance(
      fixture.state,
      fixture.candidate,
      fixture.evidence,
    );
    assert.equal(verdict.verdict, "accepted");
    assert.equal(verdict.plan, acceptancePlan.identity);
    assert.equal(verdict.candidate, fixture.evidence.candidate);
    await writeFile(join(fixture.candidate, "src/added.ts"), "export {};");
    await assert.rejects(
      consumeAcceptance(fixture.state, fixture.candidate, fixture.evidence),
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
        consumeAcceptance(fixture.state, fixture.candidate, {
          ...fixture.evidence,
          static: { ...checked, ...changed },
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
      await assert.rejects(
        consumeAcceptance(fixture.state, fixture.candidate, fixture.evidence),
        expected,
      );
    });
  await withAcceptance({}, async (fixture) => {
    const { diagnostics } = fixture.evidence;
    await assert.rejects(
      consumeAcceptance(fixture.state, fixture.candidate, {
        ...fixture.evidence,
        diagnostics: { ...diagnostics, executions: [] },
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
        consumeAcceptance(fixture.state, fixture.candidate, {
          ...fixture.evidence,
          diagnostics,
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
        consumeAcceptance(fixture.state, fixture.candidate, {
          ...fixture.evidence,
          candidate: tree,
          static: { ...fixture.evidence.static, candidate: tree },
          scenarios: fixture.evidence.scenarios.map((scenario) => ({
            ...scenario,
            candidate: tree,
          })),
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
        consumeAcceptance(fixture.state, fixture.candidate, {
          ...fixture.evidence,
          scenarios,
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
        consumeAcceptance(fixture.state, fixture.candidate, {
          ...fixture.evidence,
          artifacts,
        }),
        expected,
      );
    await writeFile(join(fixture.root, "artifacts/handlers/steps.mjs"), "");
    await assert.rejects(
      consumeAcceptance(fixture.state, fixture.candidate, fixture.evidence),
      /stale-acceptance-artifact: workflow-handlers/,
    );
  });
  await withAcceptance({}, async (fixture) => {
    await writeFile(join(fixture.root, "artifacts/package.tgz"), "changed");
    await assert.rejects(
      consumeAcceptance(fixture.state, fixture.candidate, fixture.evidence),
      /stale-acceptance-artifact: package-tarball/,
    );
  });
  await withAcceptance(
    { source: '"use workflow";\nexport const value = 1;' },
    async (fixture) => {
      await assert.rejects(
        consumeAcceptance(fixture.state, fixture.candidate, fixture.evidence),
        /unbound-acceptance-artifact: workflow-handlers/,
      );
    },
  );
});

await test("QG-12 consumption requires the active verifier outside the candidate", async () => {
  await withAcceptance({}, async (fixture) => {
    await assert.rejects(
      consumeAcceptance(fixture.root, fixture.candidate, fixture.evidence),
      /overlapping-acceptance-state/,
    );
    await writeFile(
      join(fixture.installed.directory, "tools/check-protected-quality.ts"),
      "process.exit(0);",
    );
    await assert.rejects(
      consumeAcceptance(fixture.state, fixture.candidate, fixture.evidence),
      /verifier-installation-changed/,
    );
  });
});
