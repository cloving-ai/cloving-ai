import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advisory,
  auditReport,
  installTree,
  minimist,
  threeSeverities,
  vulnerability,
} from "./dependency-audit-fixture.ts";
import { auditCandidates } from "../templates/dependency-audit/dependency-audit/audit-report.mts";
import { fakeStepBridge } from "cloving/workflows/testing";
import { auditCandidates as parsedCandidates } from "../templates/dependency-audit/dependency-audit/candidates.ts";
import { completed } from "../templates/dependency-audit/dependency-audit/scenarios.ts";

await test("CLV-318 the candidates keep the critical and the high advisory and leave out the moderate one", () => {
  const candidates = auditCandidates({
    audit: threeSeverities,
    tree: installTree,
    issues: [],
  });
  assert.deepEqual(candidates, [
    {
      name: "minimist",
      severity: "critical",
      direct: false,
      range: "<=0.2.3",
      versions: ["0.2.1"],
      effects: ["mkdirp"],
      fixAvailable: { name: "mkdirp", version: "0.5.6", isSemVerMajor: false },
      advisories: [
        {
          id: "GHSA-xvch-5gv4-984h",
          severity: "critical",
          title: "Prototype Pollution in minimist",
          url: "https://github.com/advisories/GHSA-xvch-5gv4-984h",
          vulnerableRange: "<0.2.4",
          patchedRange: ">=0.2.4",
        },
      ],
      advisoryCount: 1,
      paths: ["mkdirp@0.5.1 > minimist@0.2.1"],
      pathCount: 1,
    },
    {
      name: "undici",
      severity: "high",
      direct: false,
      range: "7.18.0 - 7.30.0",
      versions: ["7.18.0"],
      effects: [],
      fixAvailable: true,
      advisories: [
        {
          id: "GHSA-xjj6-f33q-929c",
          severity: "high",
          title: "undici vulnerable to Denial of Service via unhandled error",
          url: "https://github.com/advisories/GHSA-xjj6-f33q-929c",
          vulnerableRange: ">=7.18.0 <7.30.1",
          patchedRange: "<7.18.0 || >=7.30.1",
        },
      ],
      advisoryCount: 1,
      paths: ["workflow@1.2.0 > @workflow/core@5.0.2 > undici@7.18.0"],
      pathCount: 1,
    },
  ]);
});

const openIssue = (body: string | null, fields: object = {}) => ({
  number: 7,
  title: "Upgrade a package",
  body,
  ...fields,
});

await test("CLV-318 an advisory that an open security issue names is left out", () => {
  const candidates = auditCandidates({
    audit: threeSeverities,
    tree: installTree,
    issues: [
      [openIssue("| ghsa-xvch-5gv4-984h | critical | minimist |")],
      [openIssue(null)],
    ],
  });
  assert.deepEqual(
    candidates.map((candidate) => candidate.name),
    ["undici"],
  );
});

await test("CLV-318 an open pull request or a longer advisory ID does not leave an advisory out", () => {
  const candidates = auditCandidates({
    audit: threeSeverities,
    tree: installTree,
    issues: [
      [
        openIssue("Fixes GHSA-xvch-5gv4-984h", { pull_request: {} }),
        openIssue("See GHSA-xjj6-f33q-929c-2."),
      ],
    ],
  });
  assert.deepEqual(
    candidates.map((candidate) => candidate.name),
    ["minimist", "undici"],
  );
});

await test("CLV-318 a package keeps the advisories that no open issue names", () => {
  const second = advisory({
    id: "GHSA-4w7w-5xrc-9h26",
    source: 1243473,
    name: "undici",
    severity: "high",
    title: "undici vulnerable to cache poisoning",
    range: ">=7.0.0 <7.30.1",
  });
  const candidates = auditCandidates({
    audit: auditReport({
      undici: vulnerability("undici", {
        severity: "high",
        via: [
          advisory({
            id: "GHSA-9fm3-97px-rjf6",
            source: 1243481,
            name: "undici",
            severity: "moderate",
            title: "undici WebSocket client vulnerable",
            range: ">=7.0.0 <7.30.1",
          }),
          second,
          second,
          {
            source: 1243474,
            name: "undici",
            title: "An advisory without a GitHub URL",
            url: "https://npmjs.com/advisories/1243474",
            severity: "high",
            range: "<7.30.1",
          },
        ],
        range: "7.0.0 - 7.30.0",
      }),
    }),
    tree: installTree,
    issues: [[openIssue("Names 1243474 from the old list.")]],
  });
  assert.deepEqual(
    candidates.flatMap((candidate) =>
      candidate.advisories.map((item) => item.id),
    ),
    ["GHSA-4w7w-5xrc-9h26"],
  );
});

await test("CLV-318 at most 10 packages are candidates and the critical packages come first", () => {
  const names = Array.from(
    { length: 12 },
    (_, index) => `package-${String(index).padStart(2, "0")}`,
  );
  const vulnerabilities = Object.fromEntries(
    names.map((name, index) => {
      const severity = index % 3 === 0 ? "critical" : "high";
      return [
        name,
        vulnerability(name, {
          severity,
          via: [
            advisory({
              id: `GHSA-${String(index).padStart(4, "0")}-aaaa-bbbb`,
              source: index,
              name,
              severity,
              title: `Advisory ${String(index)}`,
              range: "<1.0.0",
            }),
          ],
          range: "<1.0.0",
        }),
      ];
    }),
  );
  const candidates = auditCandidates({
    audit: auditReport(vulnerabilities),
    tree: installTree,
    issues: [],
  });
  assert.deepEqual(
    candidates.map((candidate) => [candidate.name, candidate.severity]),
    [
      ["package-00", "critical"],
      ["package-03", "critical"],
      ["package-06", "critical"],
      ["package-09", "critical"],
      ["package-01", "high"],
      ["package-02", "high"],
      ["package-04", "high"],
      ["package-05", "high"],
      ["package-07", "high"],
      ["package-08", "high"],
    ],
  );
});

await test("CLV-318 the install paths list each place of a vulnerable version, the shortest first, at most 20", () => {
  const parents = Object.fromEntries(
    Array.from({ length: 25 }, (_, index) => [
      `parent-${String(24 - index).padStart(2, "0")}`,
      { version: "1.0.0", dependencies: { minimist: { version: "0.2.1" } } },
    ]),
  );
  const [candidate] = auditCandidates({
    audit: threeSeverities,
    tree: {
      name: "demo",
      dependencies: Object.assign(parents, {
        minimist: { version: "1.2.8" },
        broken: { version: "1.0.0", dependencies: { minimist: {} } },
      }),
    },
    issues: [],
  });
  assert.equal(candidate?.pathCount, 25);
  assert.deepEqual(candidate.versions, ["0.2.1"]);
  assert.deepEqual(candidate.paths.slice(0, 2), [
    "parent-00@1.0.0 > minimist@0.2.1",
    "parent-01@1.0.0 > minimist@0.2.1",
  ]);
  assert.equal(candidate.paths.length, 20);
});

await test("CLV-318 an unknown vulnerable range keeps every install path of the package", () => {
  const [candidate] = auditCandidates({
    audit: auditReport({
      minimist: vulnerability("minimist", {
        severity: "critical",
        via: [minimist],
        range: "^0.2.0",
      }),
    }),
    tree: installTree,
    issues: [],
  });
  assert.deepEqual(candidate?.versions, ["0.2.1", "1.2.8"]);
});

const audit = (via: unknown, fields: object = {}) =>
  auditReport({
    minimist: Object.assign(
      vulnerability("minimist", {
        severity: "critical",
        via: [via],
        range: "<1.0.0",
      }),
      fields,
    ),
  });

const unexpectedReports = [
  [{ audit: "report" }, /npm audit printed/],
  [
    { audit: { auditReportVersion: 1, vulnerabilities: {} } },
    /npm audit printed/,
  ],
  [
    { audit: { auditReportVersion: 2, vulnerabilities: [] } },
    /npm audit printed/,
  ],
  [{ audit: auditReport({ minimist: { name: 7 } }) }, /npm audit printed/],
  [{ audit: audit(minimist, { via: "minimist" }) }, /npm audit printed/],
  [{ audit: audit(7) }, /npm audit printed/],
  [
    { audit: audit(Object.assign({}, minimist, { severity: null })) },
    /npm audit printed/,
  ],
  [
    { audit: audit(Object.assign({}, minimist, { source: "1096465" })) },
    /npm audit printed/,
  ],
  [{ audit: audit(minimist, { isDirect: "yes" }) }, /npm audit printed/],
  [{ audit: audit(minimist, { effects: [7] }) }, /npm audit printed/],
  [
    {
      audit: audit(minimist, {
        fixAvailable: { name: "mkdirp", version: "1.0.0" },
      }),
    },
    /npm audit printed/,
  ],
  [{ audit: audit(minimist, { fixAvailable: "yes" }) }, /npm audit printed/],
  [{ tree: [] }, /npm ls printed/],
  [{ tree: { dependencies: [] } }, /npm ls printed/],
  [{ tree: { dependencies: { minimist: "0.2.1" } } }, /npm ls printed/],
  [{ issues: {} }, /gh printed/],
  [{ issues: [{}] }, /gh printed/],
  [{ issues: [[{ body: "GHSA-xvch-5gv4-984h" }]] }, /gh printed/],
  [{ issues: [[{ title: "Upgrade", body: 7 }]] }, /gh printed/],
] as const;

await test("CLV-318 the candidates stay inside the limits of the workflow parser and count every advisory", async () => {
  const via = Array.from({ length: 25 }, (_, index) =>
    advisory({
      id: `GHSA-${String(index).padStart(4, "a")}-aaaa-bbbb`,
      source: 2000 + index,
      name: "minimist",
      severity: index >= 22 ? "critical" : "high",
      title: `Advisory ${String(index)}`,
      range: "<1.0.0",
    }),
  );
  const parents = Object.fromEntries(
    Array.from({ length: 25 }, (_, index) => [
      `parent-${String(index).padStart(2, "0")}`,
      {
        version: "1.0.0",
        dependencies: { minimist: { version: `0.0.${String(index + 1)}` } },
      },
    ]),
  );
  const [candidate] = auditCandidates({
    audit: auditReport({
      minimist: vulnerability("minimist", {
        severity: "critical",
        via,
        range: "<1.0.0",
        effects: Array.from(
          { length: 60 },
          (_, index) => `effect-${String(index).padStart(2, "0")}`,
        ),
      }),
    }),
    tree: { name: "demo", dependencies: parents },
    issues: [],
  });
  assert.equal(candidate?.advisories.length, 20);
  assert.equal(candidate.advisoryCount, 25);
  assert.deepEqual(
    candidate.advisories.slice(0, 3).map((item) => item.severity),
    ["critical", "critical", "critical"],
  );
  assert.equal(candidate.versions.length, 20);
  assert.equal(candidate.effects.length, 50);
  using bridge = fakeStepBridge({
    effects: { "command run:audit-candidates": [completed([candidate])] },
  });
  const [parsed] = await parsedCandidates();
  assert.equal(parsed?.advisoryCount, 25);
  assert.equal(bridge.requests.length, 1);
});

await test("CLV-318 an install path longer than the parser limit is cut to 500 characters", () => {
  const names = ["a", "b", "c"].map((letter) => letter.repeat(214));
  const chain = names.reduceRight<Readonly<Record<string, unknown>>>(
    (inner, name) => ({ [name]: { version: "1.0.0", dependencies: inner } }),
    { minimist: { version: "0.2.1" } },
  );
  const [candidate] = auditCandidates({
    audit: threeSeverities,
    tree: { name: "demo", dependencies: chain },
    issues: [],
  });
  assert.equal(candidate?.pathCount, 1);
  const [path = ""] = candidate.paths;
  const [first = ""] = names;
  assert.equal(path.length, 500);
  assert.ok(path.startsWith(`${first}@1.0.0 > `));
});

await test("CLV-318 an unexpected npm audit, npm ls or gh report throws", () => {
  for (const [reports, message] of unexpectedReports)
    assert.throws(
      () =>
        auditCandidates(
          Object.assign(
            { audit: threeSeverities, tree: installTree, issues: [] },
            reports,
          ),
        ),
      message,
      JSON.stringify(reports),
    );
});
