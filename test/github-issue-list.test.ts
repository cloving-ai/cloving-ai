import assert from "node:assert/strict";
import { test } from "node:test";
import { methods } from "../src/daemon/github-methods.ts";
import { withGithub, type GithubScene } from "./github-worker-fixture.ts";

interface Row {
  readonly number: number;
  readonly day: number;
  readonly state?: string;
  readonly labels?: readonly string[];
  readonly pull?: boolean;
  readonly body?: string | null;
}

function row(given: Row): Readonly<Record<string, unknown>> {
  const kind = given.pull === true ? "pull" : "issues";
  const hour = String(given.day % 24).padStart(2, "0");
  return Object.assign(
    {
      number: given.number,
      html_url: `https://github.com/acme/demo/${kind}/${String(given.number)}`,
      title: `Title ${String(given.number)}`,
      body:
        given.body === undefined ? `Body ${String(given.number)}` : given.body,
      state: given.state ?? "open",
      created_at: `2026-11-${String(1 + Math.floor(given.day / 24)).padStart(2, "0")}T${hour}:00:00Z`,
      labels: (given.labels ?? []).map((name) => ({ name, color: "ededed" })),
    },
    given.pull === true
      ? { pull_request: { url: "https://api.github.com/pulls" } }
      : {},
  );
}

function issueCalls(scene: GithubScene): readonly (readonly string[])[] {
  return scene.state().calls.filter((call) => call[0] === "api");
}

async function listed(
  scene: GithubScene,
  payload: unknown,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const report = await scene.perform(scene.worker(), {
    method: "issues",
    payload,
  });
  assert.equal(report.outcome, "completed", JSON.stringify(report));
  const result: unknown = JSON.parse(String(report.result));
  assert.ok(Array.isArray(result));
  return result.map((item: Readonly<Record<string, unknown>>) => item);
}

await test("CLV-323 github issues leaves out pull requests and lists the issues newest first", () =>
  withGithub(async (scene) => {
    assert.ok(methods.has("issues"));
    scene.plan({
      scores: [],
      issueRows: [
        row({ number: 3, day: 3 }),
        row({ number: 4, day: 4, pull: true }),
        row({ number: 1, day: 1, body: null }),
        row({ number: 5, day: 5, pull: true }),
        row({ number: 2, day: 2, labels: ["cloving: review"] }),
      ],
    });
    const issues = await listed(scene, { labels: [], state: "all", limit: 10 });
    assert.deepEqual(issues, [
      {
        number: 3,
        url: "https://github.com/acme/demo/issues/3",
        title: "Title 3",
        body: "Body 3",
        createdAt: "2026-11-01T03:00:00Z",
        labels: [],
      },
      {
        number: 2,
        url: "https://github.com/acme/demo/issues/2",
        title: "Title 2",
        body: "Body 2",
        createdAt: "2026-11-01T02:00:00Z",
        labels: ["cloving: review"],
      },
      {
        number: 1,
        url: "https://github.com/acme/demo/issues/1",
        title: "Title 1",
        body: "",
        createdAt: "2026-11-01T01:00:00Z",
        labels: [],
      },
    ]);
  }));

await test("CLV-323 github issues returns the 7 newest issues of one label in all states", () =>
  withGithub(async (scene) => {
    const review = ["cloving: review"];
    scene.plan({
      scores: [],
      issueRows: [
        ...Array.from({ length: 9 }, (_, index) =>
          row({
            number: 10 + index,
            day: 10 + index,
            labels: review,
            state: index % 2 === 0 ? "closed" : "open",
          }),
        ),
        row({ number: 30, day: 30, labels: review, pull: true }),
        row({ number: 31, day: 31, labels: ["cloving: improvement"] }),
        row({ number: 32, day: 32 }),
      ],
    });
    const issues = await listed(scene, {
      labels: review,
      state: "all",
      limit: 7,
    });
    assert.deepEqual(
      issues.map((issue) => issue["number"]),
      [18, 17, 16, 15, 14, 13, 12],
    );
    assert.deepEqual(issues[0], {
      number: 18,
      url: "https://github.com/acme/demo/issues/18",
      title: "Title 18",
      body: "Body 18",
      createdAt: "2026-11-01T18:00:00Z",
      labels: review,
    });
    assert.deepEqual(issueCalls(scene), [
      [
        "api",
        "repos/{owner}/{repo}/issues?state=all&labels=cloving%3A%20review&sort=created&direction=desc&per_page=100&page=1",
      ],
    ]);
  }));

await test("CLV-323 github issues refuses a bad limit, state or label list before any GitHub call", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [], issueRows: [row({ number: 1, day: 1 })] });
    const worker = scene.worker();
    const valid = { labels: ["cloving: review"], state: "all", limit: 7 };
    const reasons: unknown[] = [];
    for (const payload of [
      { ...valid, limit: 0 },
      { ...valid, limit: 101 },
      { ...valid, limit: 7.5 },
      { ...valid, limit: "7" },
      { ...valid, state: "merged" },
      { ...valid, state: undefined },
      { ...valid, labels: ["a", "b", "c", "d", "e", "f"] },
      { ...valid, labels: "cloving: review" },
      { ...valid, labels: [""] },
      { ...valid, labels: [" "] },
      { ...valid, labels: ["a,b"] },
      { ...valid, labels: [7] },
      { state: "all", limit: 7 },
      { ...valid, sort: "updated" },
    ])
      reasons.push(
        (await scene.perform(worker, { method: "issues", payload })).reason,
      );
    assert.deepEqual(
      reasons,
      Array.from({ length: 14 }, () => "invalid-github-input"),
    );
    assert.deepEqual(issueCalls(scene), []);
    const edges = [];
    for (const payload of [
      { ...valid, limit: 1 },
      { ...valid, limit: 100 },
      { labels: ["a", "b", "c", "d", "e"], state: "open", limit: 1 },
      { labels: [], state: "closed", limit: 1 },
    ])
      edges.push(
        (await scene.perform(worker, { method: "issues", payload })).outcome,
      );
    assert.deepEqual(edges, [
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
  }));

function pulls(count: number, after: number) {
  return Array.from({ length: count }, (_, index) =>
    row({ number: after + index, day: after + index, pull: true }),
  );
}

function pages(scene: GithubScene): readonly string[] {
  return issueCalls(scene).map((call) => call[1]?.split("&page=")[1] ?? "");
}

await test("CLV-323 github issues reads the next page when pull requests fill a page", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      issueRows: [
        ...pulls(98, 100),
        ...[1, 2, 3, 4, 5].map((number) => row({ number, day: number })),
      ],
    });
    const issues = await listed(scene, { labels: [], state: "all", limit: 4 });
    assert.deepEqual(
      issues.map((issue) => issue["number"]),
      [5, 4, 3, 2],
    );
    assert.deepEqual(pages(scene), ["1", "2"]);
  }));

await test("CLV-323 github issues stops after 10 full pages with issues-limit", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      issueRows: [...pulls(1000, 100), row({ number: 1, day: 1 })],
    });
    const report = await scene.perform(scene.worker(), {
      method: "issues",
      payload: { labels: [], state: "all", limit: 1 },
    });
    assert.equal(report.reason, "issues-limit");
    assert.deepEqual(
      pages(scene),
      Array.from({ length: 10 }, (_, index) => String(index + 1)),
    );
  }));

await test("CLV-323 github issues lists an issue once when a new item moves it to the next page", () =>
  withGithub(async (scene) => {
    const moved = row({ number: 2, day: 2 });
    scene.plan({
      scores: [],
      sequences: {
        "api GET issues": [
          [...pulls(99, 100), moved],
          [moved, row({ number: 1, day: 1 })],
        ],
      },
    });
    const issues = await listed(scene, { labels: [], state: "all", limit: 3 });
    assert.deepEqual(
      issues.map((issue) => issue["number"]),
      [2, 1],
    );
    assert.deepEqual(pages(scene), ["1", "2"]);
  }));

await test("CLV-323 github issues fails with github-call-failed on an unexpected gh answer", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const good = row({ number: 1, day: 1, labels: ["bug"] });
    const reasons: unknown[] = [];
    for (const reply of [
      { rows: good },
      [{ ...good, number: "1" }],
      [{ ...good, number: 0 }],
      [{ ...good, number: 1.5 }],
      [{ ...good, title: null }],
      [{ ...good, body: 7 }],
      [{ ...good, html_url: undefined }],
      [{ ...good, created_at: undefined }],
      [{ ...good, labels: "bug" }],
      [{ ...good, labels: [{ color: "ededed" }] }],
      [7],
    ]) {
      scene.plan({ scores: [], replies: { "api GET issues": reply } });
      reasons.push(
        (
          await scene.perform(worker, {
            method: "issues",
            payload: { labels: [], state: "open", limit: 5 },
          })
        ).reason,
      );
    }
    scene.plan({ scores: [], garble: "api GET issues" });
    reasons.push(
      (
        await scene.perform(worker, {
          method: "issues",
          payload: { labels: [], state: "open", limit: 5 },
        })
      ).reason,
    );
    assert.deepEqual(
      reasons,
      Array.from({ length: 12 }, () => "github-call-failed"),
    );
  }));
