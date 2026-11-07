import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeStepBridge } from "cloving/workflows/testing";
import { dependencyAudit } from "./dependency-audit.ts";
import { refusalTests } from "./dependency-audit/refusal-tests.ts";
import {
  advisory,
  candidate,
  effects,
  group,
  input,
  methods,
  prompt,
  tickets,
  twoPackages,
} from "./dependency-audit/scenarios.ts";

await test("CLV-318 a day with no new critical or high advisory ends completed with no turn", async () => {
  using bridge = fakeStepBridge({ effects: effects([]), effectLimit: 9 });
  assert.deepEqual(await dependencyAudit(input), {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "dependency-audit",
    report: "No new critical or high advisory.",
  });
  assert.deepEqual(methods(bridge.requests), ["run:audit-candidates"]);
});

await test("CLV-318 a turn result with 2 groups hands off 2 tickets and each names every advisory ID of its group", async () => {
  using bridge = fakeStepBridge({
    effects: effects(twoPackages, {
      groups: [
        group(["undici"], {
          change: {
            kind: "override",
            package: "undici",
            from: "7.18.0",
            to: "7.30.1",
          },
        }),
        group(["minimist"]),
      ],
    }),
    effectLimit: 9,
  });
  const outcome = await dependencyAudit(input);
  assert.deepEqual(outcome, {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "dependency-audit",
    report:
      "Advisories: 3 in 2 packages. Ticket runs requested: 2 (minimist, undici). Left for a later audit: none.",
  });
  assert.deepEqual(methods(bridge.requests), [
    "run:audit-candidates",
    "prepare",
    "run-turn",
    "discard",
    "handoff",
    "handoff",
  ]);
  const [minimist = "", undici = ""] = tickets(bridge.requests);
  assert.ok(minimist.includes("GHSA-xvch-5gv4-984h"));
  assert.ok(minimist.includes("GHSA-vh95-rmgr-6w4m"));
  assert.ok(!minimist.includes("GHSA-xjj6-f33q-929c"));
  assert.ok(undici.includes("GHSA-xjj6-f33q-929c"));
  assert.ok(undici.includes("| <2.0.0 | none |"));
  assert.ok(!undici.includes("GHSA-xvch"));
  assert.match(
    undici,
    /^# Override undici to 7\.30\.1 for the high advisories of undici\n/,
  );
  assert.match(
    undici,
    /Add the entry `"undici": "7\.30\.1"` to `overrides` in `package\.json`/,
  );
  assert.match(minimist, /^# Upgrade minimist to 2\.0\.0 for the critical/);
});

const ticketLines = [
  "| Advisory | Severity | Package | Title | Vulnerable range | Patched range |",
  "| [GHSA-xvch-5gv4-984h](https://github.com/advisories/GHSA-xvch-5gv4-984h) | critical | minimist | Advisory GHSA-xvch-5gv4-984h \\| with a pipe | <2.0.0 | >=2.0.0 |",
  "- `mkdirp@0.5.1 > minimist@1.0.0`",
  "- `minimist@1.0.0`",
  "- 1 more path of minimist. Run `npm ls --all minimist` to see it.",
  "1. Pin `minimist` at `2.0.0` in `package.json` (installed: `1.0.0`). Then update `package-lock.json` with `npm install --ignore-scripts`.",
  "   - `2.0.0`: The parse function no longer accepts a string. Code: `src/cli/arguments.ts:41`, `test/cli.test.ts:12`. Change: Pass an array of arguments.",
  "   - `2.0.0`: Drops Node 14. Not used: The project needs Node 24.",
  "3. Give the new version the same exact pin and the same justification as the current version.",
  "4. Inspect the installed packed artifact with scripts disabled.",
  "1. `npm audit --json` on the branch lists none of the advisories of the table.",
  "2. The lock file has no version of minimist in a vulnerable range of the table.",
  "3. Each breaking change has its code change, or the reason that the project does not use it.",
  "4. The developer gate passes.",
  "- https://github.com/minimistjs/minimist/releases/tag/v2.0.0",
];

await test("CLV-318 the ticket has the PRD form, the advisory table, the paths, the change, the breaking changes and the policy", async () => {
  using bridge = fakeStepBridge({
    effects: effects(twoPackages, {
      groups: [
        group(["minimist"], {
          breakingChanges: [
            {
              version: "2.0.0",
              change: "The parse function\nno longer accepts a string.",
              uses: ["src/cli/arguments.ts:41", "test/cli.test.ts:12"],
              action: "Pass an array of arguments.",
            },
            {
              version: "2.0.0",
              change: "Drops Node 14.",
              uses: [],
              action: "The project needs Node 24.",
            },
          ],
          sources: [
            "https://github.com/minimistjs/minimist/releases/tag/v2.0.0",
          ],
        }),
      ],
    }),
  });
  await dependencyAudit(input);
  const [text = ""] = tickets(bridge.requests);
  assert.deepEqual(
    text.split("\n").filter((line) => line.startsWith("#")),
    [
      "# Upgrade minimist to 2.0.0 for the critical advisories of minimist",
      "## Problem",
      "## Desired outcome",
      "## Concrete scenario",
      "## Scope",
      "## Non-goals",
      "## Acceptance criteria",
      "## First tests",
      "## Sources",
    ],
  );
  for (const line of ticketLines)
    assert.ok(text.split("\n").includes(line), line);
});

await test("CLV-318 a group with no breaking change says so and lists no sources", async () => {
  using bridge = fakeStepBridge({
    effects: effects(twoPackages, { groups: [group(["undici"])] }),
  });
  const outcome = await dependencyAudit(input);
  const [text = ""] = tickets(bridge.requests);
  assert.ok(
    text.includes(
      "2. The release notes between `1.0.0` and `2.0.0` list no breaking change.",
    ),
  );
  assert.ok(text.includes("## Sources\n\nNone.\n"));
  assert.equal(
    outcome.kind === "handoff_requested" ? outcome.report : "",
    "Advisories: 3 in 2 packages. Ticket runs requested: 1 (undici). Left for a later audit: minimist.",
  );
});

await test("CLV-318 a ticket names the advisories that the table leaves out", async () => {
  using bridge = fakeStepBridge({
    effects: effects([candidate("minimist", { advisoryCount: 23 })], {
      groups: [group(["minimist"])],
    }),
    effectLimit: 9,
  });
  await dependencyAudit(input);
  const [ticket = ""] = tickets(bridge.requests);
  assert.ok(
    ticket.includes(
      "\n\n- 22 more advisories of minimist are not in the table. Run `npm audit --json` to see them.\n",
    ),
    ticket,
  );
});

await test("CLV-318 the turn gets the candidates as data and the rules of the plan", async () => {
  using bridge = fakeStepBridge({
    effects: effects(twoPackages, { groups: [group(["undici"])] }),
  });
  await dependencyAudit(input);
  const text = prompt(bridge.requests);
  for (const part of [
    "at most 5 groups",
    "release notes",
    "path:line",
    "overrides",
    "untrusted data",
    "12000 characters",
    JSON.stringify(twoPackages),
  ])
    assert.ok(text.includes(part), part);
});

const sevenPackages = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
].map((name, index) =>
  candidate(name, {
    severity: index % 3 === 2 ? "critical" : "high",
    advisories: [
      advisory(
        `GHSA-${String(index).padStart(4, "0")}-aaaa-bbbb`,
        index % 3 === 2 ? "critical" : "high",
      ),
    ],
  }),
);

await test("CLV-318 7 groups hand off 5 tickets and the critical groups come first", async () => {
  using bridge = fakeStepBridge({
    effects: effects(sevenPackages, {
      groups: sevenPackages.map((item) => group([item.name])),
    }),
    effectLimit: 9,
  });
  const outcome = await dependencyAudit(input);
  assert.deepEqual(
    tickets(bridge.requests).map((text) => /^# Upgrade (\S+)/.exec(text)?.[1]),
    ["charlie", "foxtrot", "alpha", "bravo", "delta"],
  );
  assert.equal(
    outcome.kind === "handoff_requested" ? outcome.report : "",
    "Advisories: 7 in 7 packages. Ticket runs requested: 5 (charlie, foxtrot, alpha, bravo, delta). Left for a later audit: echo, golf.",
  );
});

await test("CLV-318 one ticket holds the packages that one upgrade fixes and names the advisories of both", async () => {
  const packages = [
    twoPackages[0],
    Object.assign({}, twoPackages[1], {
      effects: ["@workflow/core"],
      fixAvailable: {
        name: "workflow",
        version: "2.0.6",
        isSemVerMajor: true,
        note: "x",
      },
      paths: ["workflow@1.2.0 > @workflow/core@5.0.2 > undici@7.18.0"],
      pathCount: 4,
    }),
  ];
  using bridge = fakeStepBridge({
    effects: effects(packages, {
      groups: [
        group(["undici", "minimist"], {
          change: {
            kind: "pin",
            package: "workflow",
            from: "1.2.0",
            to: "2.0.6",
          },
        }),
      ],
    }),
  });
  await dependencyAudit(input);
  const [text = ""] = tickets(bridge.requests);
  assert.match(
    text,
    /^# Upgrade workflow to 2\.0\.6 for the critical advisories of undici and minimist\n/,
  );
  for (const id of [
    "GHSA-xvch-5gv4-984h",
    "GHSA-vh95-rmgr-6w4m",
    "GHSA-xjj6-f33q-929c",
  ])
    assert.ok(text.includes(`| [${id}](`), id);
  assert.ok(
    text.includes(
      "- 3 more paths of undici. Run `npm ls --all undici` to see them.",
    ),
  );
  assert.ok(prompt(bridge.requests).includes('"effects":["@workflow/core"]'));
  assert.ok(
    prompt(bridge.requests).includes(
      '"fixAvailable":{"name":"workflow","version":"2.0.6","isSemVerMajor":true}',
    ),
  );
});

for (const scenario of refusalTests) await test(scenario.name, scenario.run);
