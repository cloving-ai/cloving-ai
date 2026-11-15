import assert from "node:assert/strict";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { withGithub } from "./github-worker-fixture.ts";

function row(given: { number: number; day: number; body: string }) {
  return {
    number: given.number,
    html_url: `https://github.com/acme/demo/issues/${String(given.number)}`,
    title: `Title ${String(given.number)}`,
    body: given.body,
    state: "open",
    created_at: `2026-11-01T${String(given.day).padStart(2, "0")}:00:00Z`,
    labels: [],
  };
}

function readPage(text: string) {
  const page = record(JSON.parse(text));
  assert.ok(page);
  const rows = page["issues"];
  assert.ok(Array.isArray(rows));
  const cursor = page["cursor"];
  assert.ok(cursor === null || typeof cursor === "number");
  return {
    issues: rows.map((row: unknown) => {
      const issue = record(row);
      assert.ok(issue);
      return issue;
    }),
    cursor,
  };
}

await test("CLV-363 paged issues keep large bodies within each effect and preserve the next cursor", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      issueRows: Array.from({ length: 5 }, (_, index) =>
        row({ number: index + 1, day: index + 1, body: "x".repeat(60 * 1024) }),
      ),
    });
    const worker = scene.worker();
    const first = await scene.perform(worker, {
      method: "issues",
      payload: { labels: [], state: "open", limit: 100, cursor: 0 },
    });
    assert.equal(first.outcome, "completed", JSON.stringify(first));
    assert.ok(Buffer.byteLength(String(first.result)) <= 262144);
    const firstPage = readPage(String(first.result));
    assert.deepEqual(
      firstPage.issues.map((issue) => issue["number"]),
      [5, 4, 3, 2],
    );
    assert.equal(firstPage.cursor, 4);
    const next = await scene.perform(worker, {
      method: "issues",
      payload: {
        labels: [],
        state: "open",
        limit: 100,
        cursor: firstPage.cursor,
      },
    });
    assert.equal(next.outcome, "completed", JSON.stringify(next));
    assert.deepEqual(JSON.parse(String(next.result)), {
      issues: [
        {
          number: 1,
          url: "https://github.com/acme/demo/issues/1",
          title: "Title 1",
          body: "x".repeat(60 * 1024),
          createdAt: "2026-11-01T01:00:00Z",
          labels: [],
        },
      ],
      cursor: null,
    });
  }));

await test("CLV-363 paged issues mark an individually oversized body and continue past it", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      issueRows: [
        row({ number: 2, day: 2, body: "\u0000".repeat(200000) }),
        row({ number: 1, day: 1, body: "Small." }),
      ],
    });
    const report = await scene.perform(scene.worker(), {
      method: "issues",
      payload: { labels: [], state: "open", limit: 100, cursor: 0 },
    });
    assert.equal(report.outcome, "completed", JSON.stringify(report));
    const result = readPage(String(report.result));
    assert.deepEqual(
      result.issues.map(({ number, body, bodyOmitted }) => ({
        number,
        body,
        bodyOmitted,
      })),
      [
        { number: 2, body: "", bodyOmitted: "result-too-large" },
        { number: 1, body: "Small.", bodyOmitted: undefined },
      ],
    );
    assert.equal(result.cursor, null);
    assert.ok(Buffer.byteLength(String(report.result)) <= 262144);
  }));

await test("CLV-363 issue cursors reject invalid values before GitHub", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    for (const cursor of [-1, 1000, 0.5, "0", null]) {
      const result = await scene.perform(worker, {
        method: "issues",
        payload: { labels: [], state: "open", limit: 100, cursor },
      });
      assert.equal(result.reason, "invalid-github-input");
    }
    assert.deepEqual(scene.state().calls, []);
  }));

await test("CLV-363 issue cursors advance past pull requests and cross GitHub page boundaries", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      issueRows: [
        ...Array.from({ length: 10 }, (_, index) => ({
          ...row({ number: 12 - index, day: 12 - index, body: "Pull." }),
          pull_request: {},
        })),
        row({ number: 2, day: 2, body: "Second." }),
        row({ number: 1, day: 1, body: "First." }),
      ],
    });
    const worker = scene.worker();
    const payload = { labels: [], state: "open", limit: 1 };
    const first = await scene.perform(worker, {
      method: "issues",
      payload: { ...payload, cursor: 0 },
    });
    const result = readPage(String(first.result));
    assert.deepEqual(
      result.issues.map((issue) => issue["number"]),
      [2],
    );
    assert.equal(result.cursor, 11);
    const next = await scene.perform(worker, {
      method: "issues",
      payload: { ...payload, cursor: 11 },
    });
    const ending = readPage(String(next.result));
    assert.deepEqual(
      ending.issues.map((issue) => issue["number"]),
      [1],
    );
    assert.equal(ending.cursor, null);
    assert.deepEqual(
      scene.state().calls.map((call) => call[1]?.split("&page=")[1]),
      ["1", "2", "2"],
    );
  }));

await test("CLV-363 issue pages refuse metadata that cannot fit without a body", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      issueRows: [
        { ...row({ number: 1, day: 1, body: "" }), title: "x".repeat(262144) },
      ],
    });
    const report = await scene.perform(scene.worker(), {
      method: "issues",
      payload: { labels: [], state: "open", limit: 100, cursor: 0 },
    });
    assert.equal(report.reason, "github-call-failed");
  }));

await test("CLV-363 issue pages encode escaped bodies and omit bodies above an explicit byte bound", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      issueRows: [
        row({ number: 3, day: 3, body: "\u0000".repeat(40000) }),
        row({ number: 2, day: 2, body: "é".repeat(40000) }),
        row({ number: 1, day: 1, body: "Small." }),
      ],
    });
    const report = await scene.perform(scene.worker(), {
      method: "issues",
      payload: {
        labels: [],
        state: "open",
        limit: 100,
        cursor: 0,
        maximumBodyBytes: 65536,
      },
    });
    assert.equal(report.outcome, "completed", JSON.stringify(report));
    const result: unknown = JSON.parse(String(report.result));
    assert.deepEqual(result, {
      issues: [
        {
          number: 3,
          url: "https://github.com/acme/demo/issues/3",
          title: "Title 3",
          body: Buffer.from("\u0000".repeat(40000)).toString("base64"),
          bodyEncoding: "base64",
          createdAt: "2026-11-01T03:00:00Z",
          labels: [],
        },
        {
          number: 2,
          url: "https://github.com/acme/demo/issues/2",
          title: "Title 2",
          body: "",
          bodyOmitted: "body-limit",
          createdAt: "2026-11-01T02:00:00Z",
          labels: [],
        },
        {
          number: 1,
          url: "https://github.com/acme/demo/issues/1",
          title: "Title 1",
          body: "Small.",
          createdAt: "2026-11-01T01:00:00Z",
          labels: [],
        },
      ],
      cursor: null,
    });
    assert.ok(Buffer.byteLength(String(report.result)) < 262144);
  }));
