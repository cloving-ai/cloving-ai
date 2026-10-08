import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { dependencySurface } from "../../quality/dependency-surface.ts";
import { admitDependencies } from "../../quality/dependency-admission.ts";
import type { DependencyQualification } from "../../quality/dependency-admission.ts";
import { withFiles } from "./files-fixture.ts";

const baselineFiles = {
  "package.json": '{"name":"fixture","version":"1.0.0"}',
  "package-lock.json":
    '{"lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}',
  "dist/runtime.js": "export const value = 1;",
};

for (const [name, path, content] of [
  ["unexplained package", "package.json", '{"dependencies":{"extra":"1.0.0"}}'],
  [
    "nested manifest",
    "nested/package.json",
    '{"dependencies":{"extra":"1.0.0"}}',
  ],
  [
    "optional and peer routes",
    "package.json",
    '{"optionalDependencies":{"extra":"1.0.0"},"peerDependencies":{"peer":"1.0.0"}}',
  ],
  [
    "lock-only transitive change",
    "package-lock.json",
    '{"lockfileVersion":3,"packages":{"node_modules/extra":{"version":"1.0.0"}}}',
  ],
  [
    "alias override",
    "package.json",
    '{"dependencies":{"alias":"npm:extra@1.0.0"},"overrides":{"extra":"2.0.0"}}',
  ],
  [
    "installed payload",
    "node_modules/tool/index.js",
    "export const hidden = 1;",
  ],
  ["vendored input", "vendor/extra.js", "export const hidden = 1;"],
  [
    "development tool in runtime output",
    "dist/runtime.js",
    'import "development-tool";',
  ],
] as const) {
  await test(`QG-20 rejects unreviewed ${name}`, async () => {
    await withFiles(baselineFiles, async (directory) => {
      const before = await dependencySurface(directory, ["dist/runtime.js"]);
      await mkdir(join(directory, path, ".."), { recursive: true });
      await writeFile(join(directory, path), content);
      const after = await dependencySurface(directory, ["dist/runtime.js"]);
      assert.notEqual(after.digest, before.digest);
      assert.throws(() => {
        admitDependencies(after.digest, {
          baseline: before.digest,
          qualifications: [],
        });
      }, /unreviewed-dependency-surface/);
    });
  });
}

const qualification: DependencyQualification = {
  baseline: "baseline",
  candidate: "candidate",
  capability: "A required parser behavior",
  alternatives:
    "Existing parser lacks the required syntax; rebuilding it is not justified",
  risks:
    "Exact closure, source, licenses, scripts, supported platform and shipped footprint reviewed",
  review: "independent-review-digest",
  checks: ["targeted-test-evidence-digest", "packed-closure-evidence-digest"],
  scope: "within-grant",
};

await test("QG-20 admits an exact trusted qualification without a routine human decision", () => {
  assert.equal(
    admitDependencies("candidate", {
      baseline: "baseline",
      qualifications: [qualification],
    }),
    "qualified",
  );
  assert.equal(
    admitDependencies("baseline", { baseline: "baseline", qualifications: [] }),
    "unchanged",
  );
});

for (const change of [
  { review: "" },
  { alternatives: "" },
  { risks: "" },
  { checks: [] },
  { baseline: "other" },
  { candidate: "other" },
]) {
  await test(`QG-20 rejects incomplete or mismatched qualification ${JSON.stringify(change)}`, () => {
    assert.throws(() => {
      admitDependencies("candidate", {
        baseline: "baseline",
        qualifications: [{ ...qualification, ...change }],
      });
    });
  });
}

await test("QG-20 requires a scoped decision for a change beyond the grant", () => {
  assert.throws(() => {
    admitDependencies("candidate", {
      baseline: "baseline",
      qualifications: [{ ...qualification, scope: "design-decision" }],
    });
  }, /dependency-design-decision/);
  assert.equal(
    admitDependencies("candidate", {
      baseline: "baseline",
      qualifications: [
        {
          ...qualification,
          scope: "design-decision",
          decision: "approved-scoped-decision",
        },
      ],
    }),
    "qualified",
  );
});

await test("QG-20 candidate policy files cannot grant dependency admission", async () => {
  await withFiles(
    {
      ...baselineFiles,
      "candidate-policy.json": JSON.stringify(qualification),
    },
    async (directory) => {
      const surface = await dependencySurface(directory, ["dist/runtime.js"]);
      assert.throws(() => {
        admitDependencies(surface.digest, {
          baseline: "accepted",
          qualifications: [],
        });
      }, /unreviewed-dependency-surface/);
    },
  );
});
