import assert from "node:assert/strict";
import { test } from "node:test";
import { withGithub } from "./github-worker-fixture.ts";
import { ticketLimits, ticketText } from "../src/daemon/ticket-source.ts";

const payload = {
  owner: "acme",
  repository: "demo",
  number: 42,
  pullRequest: 7,
  remaining: ["Finish tests."],
};
const original = {
  repository: "acme/demo",
  number: 42,
  state: "open",
  body: "Original.",
  labels: ["keep"],
};
const settings = { privateTexts: ["secret-project"] };

await test("CLV-123 malformed issue reads cannot overwrite the issue body", () =>
  withGithub(async (scene) => {
    const worker = scene.worker(settings);
    for (const change of [
      { body: 17 },
      { number: 99 },
      { state: "unknown" },
      { pull_request: {} },
    ]) {
      scene.plan({
        scores: [],
        issues: [original],
        replies: { "api GET issue": { ...original, ...change } },
      });
      const report = await scene.perform(worker, {
        method: "partial-issue",
        payload,
      });
      assert.equal(report.outcome, "failed", JSON.stringify(change));
      assert.deepEqual(scene.state().issues, [original]);
    }
  }));

await test("CLV-123 invalid status payloads fail before any GitHub call", () =>
  withGithub(async (scene) => {
    const worker = scene.worker(settings);
    for (const change of [
      { owner: "a/b" },
      { number: 0 },
      { number: Number.MAX_SAFE_INTEGER + 1 },
      { pullRequest: "7" },
      { remaining: [] },
      { remaining: ["two\nlines"] },
    ]) {
      const report = await scene.perform(worker, {
        method: "partial-issue",
        payload: { ...payload, ...change },
      });
      assert.equal(report.reason, "invalid-payload");
    }
    assert.deepEqual(scene.state().calls, []);
  }));

for (const method of ["partial-issue", "close-issue"])
  await test(`CLV-123 ${method} preserves fenced status examples and following requirements`, () =>
    withGithub(async (scene) => {
      for (const fence of ["```markdown", "   ~~~~markdown", "````"])
        for (const history of [
          "",
          "## Cloving status\n- Earlier update.\n\n",
        ]) {
          const delimiter = fence.trimStart().replace("markdown", "");
          const body = [
            "Example:",
            fence,
            "## Cloving status",
            "- Pull request #1: partial. Remaining: Example only.",
            delimiter[0] === "`" && delimiter.length > 3 ? "```" : "text",
            delimiter,
            "",
            history + "## Requirements",
            "Keep this text.",
            "",
          ].join("\n");
          scene.plan({ scores: [], issues: [{ ...original, body }] });
          const report = await scene.perform(scene.worker(settings), {
            method,
            payload,
          });
          assert.equal(report.outcome, "completed", JSON.stringify(report));
          const outside = body.replace(history || "unmatched history", "");
          const update =
            method === "partial-issue"
              ? "- Pull request #7: partial. Remaining: Finish tests."
              : "Completed in pull request #7.";
          assert.equal(
            scene.state().issues[0]?.["body"],
            `${outside}\n## Cloving status\n${history === "" ? "" : "- Earlier update.\n"}${update}\n`,
          );
        }
    }));

await test("CLV-123 a status section ends only at a heading outside its fenced content", () =>
  withGithub(async (scene) => {
    const section =
      "## Cloving status\nEarlier text.\n```\n## Example heading\n```\n";
    const outside = "Original.\n\n## Requirements\nKeep this text.\n";
    scene.plan({
      scores: [],
      issues: [
        {
          ...original,
          body: outside.replace(
            "## Requirements",
            `${section}\n## Requirements`,
          ),
        },
      ],
    });
    const report = await scene.perform(scene.worker(settings), {
      method: "partial-issue",
      payload,
    });
    assert.equal(report.outcome, "completed");
    assert.equal(
      scene.state().issues[0]?.["body"],
      `${outside}\n${section}- Pull request #7: partial. Remaining: Finish tests.\n`,
    );
  }));

await test("CLV-123 oversized remaining history uses a short notice and leaves the next ticket readable", () =>
  withGithub(async (scene) => {
    const body = "界".repeat(8_300);
    const earlier = "- Pull request #6: partial. Remaining: Earlier work.";
    scene.plan({
      scores: [],
      issues: [
        { ...original, body: `${body}\n\n## Cloving status\n${earlier}\n` },
      ],
    });
    const worker = scene.worker(settings);
    for (const pullRequest of [7, 8]) {
      const report = await scene.perform(worker, {
        method: "partial-issue",
        payload: { ...payload, pullRequest, remaining: ["界".repeat(10_000)] },
      });
      assert.equal(report.outcome, "completed", JSON.stringify(report));
      const updated = String(scene.state().issues[0]?.["body"]);
      assert.ok(
        updated.startsWith(`${body}\n\n## Cloving status\n${earlier}\n`),
      );
      assert.ok(
        updated.includes(
          `- Pull request #${String(pullRequest)}: partial. Remaining: Remaining work is in the private run report.`,
        ),
      );
      const ticket = `# ${"界".repeat(256)}\n\nGitHub issue: acme/demo#42 (open)\n\n${updated}\n\nNotes for the worker.\n`;
      const read = await ticketText(
        [
          process.execPath,
          "-e",
          "process.stdout.write(process.argv[1])",
          ticket,
        ],
        { ticketId: "42", signal: new AbortController().signal },
      );
      assert.deepEqual(read, { kind: "read", text: ticket.trim() });
    }
    assert.deepEqual(scene.state().issues[0]?.["labels"], [
      "keep",
      "cloving: blocked",
    ]);
  }));

await test("CLV-123 a ticket too large for even the short notice is never requeued", () =>
  withGithub(async (scene) => {
    const issue = {
      ...original,
      body: "x".repeat(ticketLimits.textBytes - 20),
    };
    scene.plan({ scores: [], issues: [issue] });
    const report = await scene.perform(scene.worker(settings), {
      method: "partial-issue",
      payload,
    });
    assert.equal(report.outcome, "failed");
    assert.deepEqual(scene.state().issues, [issue]);
    assert.ok(
      scene
        .state()
        .calls.every((call) => !call.includes("PATCH") && call[0] !== "issue"),
    );
  }));

for (const method of ["partial-issue", "close-issue"])
  await test(`CLV-123 ${method} refuses an unclosed fence without hiding status or duplicating a retry`, () =>
    withGithub(async (scene) => {
      const issue = { ...original, body: "Example:\n```text\nExample content" };
      scene.plan({ scores: [], issues: [issue] });
      const worker = scene.worker(settings);
      for (const attempt of [1, 2]) {
        const report = await scene.perform(worker, { method, payload });
        assert.equal(report.outcome, "failed", String(attempt));
        assert.deepEqual(scene.state().issues, [issue]);
      }
      assert.ok(
        scene
          .state()
          .calls.every(
            (call) => !call.includes("PATCH") && call[0] !== "issue",
          ),
      );
    }));

await test("CLV-123 an oversized existing partial line cannot requeue an unreadable ticket on retry", () =>
  withGithub(async (scene) => {
    const issue = {
      ...original,
      body:
        "x".repeat(47_900) +
        "\n\n## Cloving status\n- Pull request #7: partial. Remaining: Earlier work.\n",
    };
    scene.plan({ scores: [], issues: [issue] });
    const report = await scene.perform(scene.worker(settings), {
      method: "partial-issue",
      payload,
    });
    assert.equal(report.outcome, "failed");
    assert.deepEqual(scene.state().issues, [issue]);
    assert.ok(
      scene
        .state()
        .calls.every((call) => !call.includes("PATCH") && call[0] !== "issue"),
    );
  }));
