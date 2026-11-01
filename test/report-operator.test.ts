import assert from "node:assert/strict";
import { test } from "node:test";
import { readReportGithub } from "../src/cli/report-github.ts";
import type { Fields } from "../src/protocol.ts";
import { loopReport } from "../src/report.ts";
import { githubReportFixture, since, output } from "./report-github-fixture.ts";
import { effectEvents } from "./report-fixture.ts";
import { fields } from "./service-fixture.ts";

const at = Date.parse("2026-10-24T12:00:00Z");
function pull(number: number) {
  return {
    number,
    html_url: `https://github.example/fixture/demo/pull/${String(number)}`,
    updated_at: new Date(at).toISOString(),
    merged_at: new Date(at).toISOString(),
  };
}
function event(
  id: number,
  options: {
    readonly issue: number;
    readonly extra?: Readonly<Record<string, unknown>>;
  },
) {
  return {
    id,
    issue: { number: options.issue },
    event: "unlabeled",
    label: { name: "cloving: blocked" },
    created_at: new Date(at).toISOString(),
    ...options.extra,
  };
}
async function report(
  options: {
    readonly failure?: string;
    readonly effects?: readonly Fields[] | null;
  } = {},
) {
  const scene = githubReportFixture({
    pulls: [pull(600), pull(602)],
    responses: {
      "repos/fixture/demo/issues/events?per_page=100&page=1": output([
        event(1, { issue: 601 }),
        event(2, { issue: 603 }),
        event(3, { issue: 604, extra: { event: "labeled" } }),
        event(4, { issue: 605, extra: { label: { name: "bug" } } }),
        event(5, { issue: 606, extra: { created_at: "2026-10-23T12:00:00Z" } }),
      ]),
      ...(options.failure === undefined
        ? {}
        : {
            [options.failure]: {
              ...output(null),
              status: 4,
              stderr: "authentication required",
            },
          }),
    },
  });
  const github = await readReportGithub({ since, settings: scene.settings });
  return loopReport({
    since: 24,
    now: Date.parse("2026-10-25T00:00:00Z"),
    completions: [],
    observedSince: 0,
    github,
    effects:
      options.effects === undefined
        ? [
            ...effectEvents("daemon-merge", {
              method: "merge",
              sequence: 1,
              at: at - 60_000,
              payload: { number: 602 },
              result: { merged: true, number: 602 },
            }),
            ...effectEvents("daemon-label", {
              method: "label",
              sequence: 3,
              at: at - 60_000,
              payload: { number: 603 },
            }),
            ...effectEvents("late-label", {
              method: "label",
              sequence: 5,
              at: at + 60_001,
              payload: { number: 604 },
            }),
          ]
        : options.effects,
  });
}

await test("CLV-246 operator merges and cloving label changes exclude matching daemon effects", async () => {
  const result = await report();
  const operator = fields(
    fields(result)["operator"] ?? fields(result.coverage)["operator"],
  );
  assert.equal(operator["reason"], undefined);
  assert.equal(fields(operator["merges"])["value"], 1);
  assert.deepEqual(fields(operator["merges"])["evidence"], [
    { pullRequest: 600 },
  ]);
  assert.equal(fields(operator["labelChanges"])["value"], 2);
  assert.deepEqual(fields(operator["labelChanges"])["evidence"], [
    { issue: 601, eventId: 1, event: "unlabeled", label: "cloving: blocked" },
    { issue: 604, eventId: 3, event: "labeled", label: "cloving: blocked" },
  ]);
  assert.match(
    String(fields(result.semantics)["operatorLabels"]),
    /time.*2.minutes/,
  );
});

await test("CLV-246 operator source failures do not hide independent values", async () => {
  const labels = fields(
    fields(
      await report({
        failure: "repos/fixture/demo/issues/events?per_page=100&page=1",
      }),
    )["operator"],
  );
  assert.equal(fields(labels["labelChanges"])["value"], null);
  assert.equal(fields(labels["merges"])["value"], 1);
  const pulls = fields(
    fields(
      await report({
        failure:
          "repos/fixture/demo/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1",
      }),
    )["operator"],
  );
  assert.equal(fields(pulls["merges"])["value"], null);
  assert.equal(fields(pulls["labelChanges"])["value"], 2);
  const daemon = fields(fields(await report({ effects: null }))["operator"]);
  assert.equal(fields(daemon["merges"])["status"], "unavailable");
  assert.equal(fields(daemon["labelChanges"])["status"], "unavailable");
});

await test("CLV-246 label history reads all pages and refuses duplicates or malformed events", async () => {
  const first = Array.from({ length: 100 }, (_, index) =>
    event(index + 1, { issue: 700 + index }),
  );
  const cases = [
    { second: [event(101, { issue: 900 })], expected: 101 },
    { second: [first[0]], expected: null },
    {
      second: [event(101, { issue: 900, extra: { label: null } })],
      expected: null,
    },
    {
      second: [event(101, { issue: 900, extra: { issue: {} } })],
      expected: null,
    },
  ];
  for (const { second, expected } of cases) {
    const scene = githubReportFixture({
      responses: {
        "repos/fixture/demo/issues/events?per_page=100&page=1": output(first),
        "repos/fixture/demo/issues/events?per_page=100&page=2": output(second),
      },
    });
    const result = await readReportGithub({ since, settings: scene.settings });
    assert.equal(result.labels?.length ?? null, expected);
  }
});

await test("CLV-246 operator matching uses the inclusive two minute boundary and ignores unsuccessful merges", async () => {
  const effects = [
    ...effectEvents("before", {
      method: "label",
      sequence: 1,
      at: at - 180_000,
      payload: { number: 601 },
    }),
    ...effectEvents("after", {
      method: "label",
      sequence: 3,
      at: at + 60_000,
      payload: { number: 603 },
    }),
    ...effectEvents("failed-merge", {
      method: "merge",
      sequence: 5,
      at,
      payload: { number: 600 },
      result: { merged: true },
      outcome: "failed",
    }),
    ...effectEvents("false-merge", {
      method: "merge",
      sequence: 7,
      at,
      payload: { number: 602 },
      result: { merged: false },
    }),
  ];
  const result = await report({ effects });
  assert.equal(result.operator.merges.value, 2);
  assert.equal(result.operator.labelChanges.value, 1);
});

await test("CLV-246 malformed matching daemon effects make their operator value unavailable", async () => {
  for (const method of ["merge", "label"] as const) {
    const result = await report({
      effects: effectEvents("malformed", {
        method,
        sequence: 1,
        at,
        payload: {},
        result: { merged: true },
      }),
    });
    assert.equal(
      result.operator[method === "merge" ? "merges" : "labelChanges"].value,
      null,
    );
  }
});

await test("CLV-246 daemon merge commit receipts do not count as operator merges", async () => {
  const result = await report({
    effects: effectEvents("daemon-sha", {
      method: "merge",
      sequence: 1,
      at,
      payload: { number: 600 },
      result: { number: 600, merged: "a".repeat(40) },
    }),
  });
  assert.equal(result.operator.merges.value, 1);
  assert.deepEqual(result.operator.merges.evidence, [{ pullRequest: 602 }]);
});

await test("CLV-246 label discovery excludes older changes and unrelated issue events", async () => {
  const scene = githubReportFixture({
    responses: {
      "repos/fixture/demo/issues/events?per_page=100&page=1": output([
        {
          id: 1,
          event: "closed",
          issue: { number: 700 },
          created_at: "2026-10-24T12:00:00Z",
        },
        event(2, { issue: 701, extra: { created_at: "2026-10-16T12:00:00Z" } }),
      ]),
    },
  });
  const result = await readReportGithub({ since, settings: scene.settings });
  assert.equal(result.sources.labels.status, "available");
  assert.deepEqual(result.labels, []);
});
