import assert from "node:assert/strict";
import { test } from "node:test";
import { statusBody, withGithub } from "./github-worker-fixture.ts";
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
  for (const [history, description] of [
    ["", "no legacy section"],
    ["## Cloving status\n- Earlier update.\n\n", "a legacy section"],
  ] as const)
    await test(`CLV-146 ${method} preserves fenced examples with ${description}`, () =>
      withGithub(async (scene) => {
        for (const fence of ["```markdown", "   ~~~~markdown", "````"]) {
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
          assert.equal(
            scene.state().issues[0]?.["body"],
            statusBody(
              history === "" ? body : body.slice(0, body.indexOf(history)),
              {
                partialRuns:
                  method === "partial-issue"
                    ? [{ pullRequest: 7, remaining: payload.remaining }]
                    : [],
                completedPullRequest: method === "close-issue" ? 7 : undefined,
              },
            ),
          );
        }
      }));

await test("CLV-146 a legacy status section without a block is replaced through the end", () =>
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
      statusBody("Original.\n\n", {
        partialRuns: [{ pullRequest: 7, remaining: payload.remaining }],
      }),
    );
  }));

await test("CLV-123 oversized remaining history uses a short notice and leaves the next ticket readable", () =>
  withGithub(async (scene) => {
    const body = "界".repeat(8_300);
    const earlier = [{ pullRequest: 6, remaining: ["Earlier work."] }];
    scene.plan({
      scores: [],
      issues: [
        { ...original, body: statusBody(body, { partialRuns: earlier }) },
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
        updated.startsWith(
          `${body}\n\n## Cloving status\n- Pull request #6: partial. Remaining: Earlier work.\n`,
        ),
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
  await test(`CLV-123 ${method} preserves list-item fences and following requirements`, () =>
    withGithub(async (scene) => {
      const examples = [
        "- ```text\n  example\n  ```",
        "* ~~~~text\n  ## Cloving status\n  ~~~~",
        "+ ```text\n  - not another container\n  ```",
        "1. ```text\n   example\n   ```",
        "123) ```text\n     ## Cloving status\n     ```",
        "- Parent\n  - ```text\n    ## Cloving status\n    ```",
        "1. Parent\n\n   2. ```text\n      example\n      ```",
        "Notes:\n1. ```text\n   example\n   ```",
        "Notes:\n\n2. ```text\n   example\n   ```",
        "## Notes\n2. ```text\n   example\n   ```",
        "Notes:\n---\n2. ```text\n   example\n   ```",
        "Notes:\n===\n2. ```text\n   example\n   ```",
        "* * *\n2. ```text\n   example\n   ```",
        "```text\nexample\n```\n2. ```text\n   example\n   ```",
        "    Indented code.\n2. ```text\n   example\n   ```",
        "- Example\n\n  ```text\n  ## Cloving status\n  ```",
        "-\t```text\n\texample\n\t```",
        "-\n\n  ```text\n  example\n  ```",
        "  -    ```text\n       example\n       ```",
        "- Parent\n  - Child\n- ```text\n  example\n  ```",
      ];
      const worker = scene.worker(settings);
      for (const example of examples) {
        const body = `${example}\n\n## Requirements\nKeep this.\n`;
        scene.plan({ scores: [], issues: [{ ...original, body }] });
        const report = await scene.perform(worker, { method, payload });
        assert.equal(
          report.outcome,
          "completed",
          JSON.stringify({
            example,
            report,
          }),
        );
        assert.equal(
          scene.state().issues[0]?.["body"],
          statusBody(body, {
            partialRuns:
              method === "partial-issue"
                ? [{ pullRequest: 7, remaining: payload.remaining }]
                : [],
            completedPullRequest: method === "close-issue" ? 7 : undefined,
          }),
        );
      }
    }));

for (const method of ["partial-issue", "close-issue"])
  await test(`CLV-123 ${method} preserves thematic breaks followed by indented code`, () =>
    withGithub(async (scene) => {
      const worker = scene.worker(settings);
      for (const separator of ["* * *", "- - -", "_ _ _", "***", "   -  - -"]) {
        const body = `${separator}\n      \`\`\`text\n      Literal code.\n\n## Requirements\nKeep this.\n`;
        scene.plan({ scores: [], issues: [{ ...original, body }] });
        const report = await scene.perform(worker, { method, payload });
        assert.equal(report.outcome, "completed", JSON.stringify(report));
        assert.equal(
          scene.state().issues[0]?.["body"],
          statusBody(body, {
            partialRuns:
              method === "partial-issue"
                ? [{ pullRequest: 7, remaining: payload.remaining }]
                : [],
            completedPullRequest: method === "close-issue" ? 7 : undefined,
          }),
        );
      }
    }));

for (const method of ["partial-issue", "close-issue"])
  await test(`CLV-123 ${method} preserves numbered paragraph continuations and their fences`, () =>
    withGithub(async (scene) => {
      const worker = scene.worker(settings);
      for (const marker of ["2.", "2)", "123.", "0."])
        for (const prefix of ["", "- "]) {
          const indent = " ".repeat(prefix.length);
          const body = [
            `${prefix}Notes:`,
            `${indent}${marker} example`,
            `${indent}   \`\`\`text`,
            `${indent}code`,
            `${indent}\`\`\``,
            "",
            "## Requirements",
            "Keep this.",
            "",
          ].join("\n");
          scene.plan({ scores: [], issues: [{ ...original, body }] });
          const report = await scene.perform(worker, { method, payload });
          assert.equal(report.outcome, "completed", JSON.stringify(report));
          assert.equal(
            scene.state().issues[0]?.["body"],
            statusBody(body, {
              partialRuns:
                method === "partial-issue"
                  ? [{ pullRequest: 7, remaining: payload.remaining }]
                  : [],
              completedPullRequest: method === "close-issue" ? 7 : undefined,
            }),
          );
        }
    }));

for (const method of ["partial-issue", "close-issue"])
  await test(`CLV-123 ${method} accepts an unclosed fence and reconciles the status on retry`, () =>
    withGithub(async (scene) => {
      const issue = { ...original, body: "Example:\n```text\nExample content" };
      scene.plan({ scores: [], issues: [issue] });
      const worker = scene.worker(settings);
      for (const attempt of [1, 2]) {
        const report = await scene.perform(worker, { method, payload });
        assert.equal(report.outcome, "completed", String(attempt));
        assert.equal(
          scene.state().issues[0]?.["body"],
          statusBody(issue.body, {
            partialRuns:
              method === "partial-issue"
                ? [{ pullRequest: 7, remaining: payload.remaining }]
                : [],
            completedPullRequest: method === "close-issue" ? 7 : undefined,
          }),
        );
      }
      assert.equal(
        scene.state().calls.filter((call) => call.includes("PATCH")).length,
        1,
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
