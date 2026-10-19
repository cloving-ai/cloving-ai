import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { statusBody, withGithub } from "./github-worker-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

const payload = {
  owner: "acme",
  repository: "demo",
  number: 42,
  pullRequest: 7,
  remaining: ["Add recovery.", "Verify restart."],
};
const original = {
  repository: "acme/demo",
  number: 42,
  state: "open",
  labels: ["keep", "cloving: in progress"],
};
const settings = { privateTexts: ["private-project"] };

await test("CLV-146 replaces the legacy status section while preserving the issue body", () =>
  withGithub(async (scene) => {
    const outside = "Original body.\n\n## Acceptance\nKeep this text.\n\n";
    const body = `${outside}## Cloving status\n- Old remaining item.\n\nOld details.\n`;
    for (const method of ["partial-issue", "close-issue"]) {
      scene.plan({ scores: [], issues: [{ ...original, body }] });
      const report = await scene.perform(scene.worker(settings), {
        method,
        payload,
      });
      assert.equal(report.outcome, "completed", JSON.stringify(report));
      assert.equal(
        scene.state().issues[0]?.["body"],
        statusBody(outside, {
          partialRuns:
            method === "partial-issue"
              ? [{ pullRequest: 7, remaining: payload.remaining }]
              : [],
          completedPullRequest: method === "close-issue" ? 7 : undefined,
        }),
      );
    }
  }));

await test("CLV-146 replaces legacy sections after a triple-backtick inline code span", () =>
  withGithub(async (scene) => {
    const outside = "Original.\n\n```example```\n\n";
    for (const method of ["partial-issue", "close-issue"]) {
      scene.plan({
        scores: [],
        issues: [
          {
            ...original,
            body: `${outside}## Cloving status\n- Earlier update.\n`,
          },
        ],
      });
      const report = await scene.perform(scene.worker(settings), {
        method,
        payload,
      });
      assert.equal(report.outcome, "completed", JSON.stringify(report));
      assert.equal(
        scene.state().issues[0]?.["body"],
        statusBody(outside, {
          partialRuns:
            method === "partial-issue"
              ? [{ pullRequest: 7, remaining: payload.remaining }]
              : [],
          completedPullRequest: method === "close-issue" ? 7 : undefined,
        }),
      );
    }
  }));

await test("CLV-146 replaces legacy sections after list-item code fences", () =>
  withGithub(async (scene) => {
    for (const example of [
      "- ```text\n  example\n  ```",
      "- Parent\n  - ~~~~text\n    example\n    ~~~~",
      "1. ```text\n   example\n   ```",
    ]) {
      const outside = `Original.\n\n${example}\n\n`;
      scene.plan({
        scores: [],
        issues: [
          {
            ...original,
            body: `${outside}## Cloving status\n- Earlier update.\n`,
          },
        ],
      });
      const report = await scene.perform(scene.worker(settings), {
        method: "partial-issue",
        payload,
      });
      assert.equal(report.outcome, "completed", JSON.stringify(report));
      assert.equal(
        scene.state().issues[0]?.["body"],
        statusBody(outside, {
          partialRuns: [{ pullRequest: 7, remaining: payload.remaining }],
        }),
      );
    }
  }));

await test("CLV-123 an incomplete block with 40000 spaces cannot stall the GitHub worker", () =>
  withFiles({}, (directory) => {
    const script = `
      import assert from "node:assert/strict";
      const { withGithub } = await import(process.argv[1]);
      await withGithub(async (scene) => {
        scene.plan({ scores: [], issues: [{
          repository: "acme/demo", number: 42, state: "open", labels: [],
          body: "Original.\\n\\n<!-- cloving-status\\n" + " ".repeat(40000),
        }] });
        const report = await scene.perform(scene.worker({ privateTexts: ["private-project"] }), {
          method: "partial-issue",
          payload: { owner: "acme", repository: "demo", number: 42, pullRequest: 7, remaining: ["Finish tests."] },
        });
        assert.equal(report.outcome, "completed", JSON.stringify(report));
        assert.deepEqual(scene.state().issues[0].labels, ["cloving: ready"]);
      });
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        pathToFileURL(join(import.meta.dirname, "github-worker-fixture.ts"))
          .href,
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, TMPDIR: directory },
      },
    );
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }));

await test("CLV-123 JSON history determines partial counts independently of readable Markdown", () =>
  withGithub(async (scene) => {
    const earlier = [{ pullRequest: 5, remaining: ["Earlier exact item."] }];
    const body =
      "Original.\n\n## Cloving status\n- Pull request #1: partial. Remaining: Example only.\n";
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
        payload: { ...payload, pullRequest },
      });
      assert.equal(report.outcome, "completed", JSON.stringify(report));
      earlier.push({ pullRequest, remaining: [...payload.remaining] });
      assert.equal(
        scene.state().issues[0]?.["body"],
        statusBody(body, { partialRuns: earlier }),
      );
      assert.deepEqual(scene.state().issues[0]?.["labels"], [
        "keep",
        pullRequest === 7 ? "cloving: ready" : "cloving: blocked",
      ]);
    }
  }));

await test("CLV-123 a nonterminal status block cannot consume following issue requirements", () =>
  withGithub(async (scene) => {
    const body =
      statusBody("Original.", {
        partialRuns: [{ pullRequest: 5, remaining: ["Earlier."] }],
      }) + "\n## Requirements\nKeep these newer requirements.\n";
    scene.plan({ scores: [], issues: [{ ...original, body }] });
    const report = await scene.perform(scene.worker(settings), {
      method: "partial-issue",
      payload,
    });
    assert.equal(report.outcome, "completed", JSON.stringify(report));
    assert.equal(
      scene.state().issues[0]?.["body"],
      statusBody(body, {
        partialRuns: [{ pullRequest: 7, remaining: payload.remaining }],
      }),
    );
    assert.deepEqual(scene.state().issues[0]?.["labels"], [
      "keep",
      "cloving: ready",
    ]);
  }));

await test("CLV-123 broken and unknown terminal blocks reset history and never prevent a status write", () =>
  withGithub(async (scene) => {
    const worker = scene.worker(settings);
    const invalid = [
      "{broken}",
      "null",
      "[]",
      '{"version":2,"partialRuns":[]}',
      '{"version":1,"partialRuns":null}',
      '{"version":1,"partialRuns":[{"pullRequest":0,"remaining":["Work."]}]}',
      '{"version":1,"partialRuns":[{"pullRequest":5,"remaining":[]}]}',
      '{"version":1,"partialRuns":[],"completedPullRequest":"7"}',
      '{"version":1,"partialRuns":[null]}',
      '{"version":1,"partialRuns":[{"pullRequest":5,"remaining":[17]}]}',
      '{"version":1,"partialRuns":[{"pullRequest":5,"remaining":[" "]}]}',
      '{"version":1,"partialRuns":[{"pullRequest":5,"remaining":["two\\nlines"]}]}',
      '{"version":1,"partialRuns":[{"pullRequest":5,"remaining":["First."]},{"pullRequest":5,"remaining":["Duplicate."]}]}',
    ];
    for (const json of invalid) {
      const outside =
        "Original.\n\n## Cloving status\n- Pull request #1: partial. Remaining: Untrusted readable history.\n\n## Cloving status\n\n\n";
      const body = `${outside}<!-- cloving-status\n${json}\n-->\n`;
      scene.plan({ scores: [], issues: [{ ...original, body }] });
      const report = await scene.perform(worker, {
        method: "partial-issue",
        payload,
      });
      assert.equal(
        report.outcome,
        "completed",
        JSON.stringify({ json, report }),
      );
      assert.equal(
        scene.state().issues[0]?.["body"],
        statusBody(outside, {
          partialRuns: [
            { pullRequest: payload.pullRequest, remaining: payload.remaining },
          ],
        }),
      );
      assert.deepEqual(scene.state().issues[0]?.["labels"], [
        "keep",
        "cloving: ready",
      ]);
    }
  }));

await test("CLV-123 fences, numbered paragraphs, nested lists, HTML and tables never change JSON history counts", () =>
  withGithub(async (scene) => {
    const worker = scene.worker(settings);
    const earlier = [{ pullRequest: 5, remaining: ["First exact item."] }];
    const examples = [
      "```markdown\n## Cloving status\n- Pull request #1: partial. Remaining: Example.\n```",
      "Notes:\n2. paragraph\n   ```text\ncode\n```",
      "- Parent\n  1. Child\n     - ```text\n       ## Cloving status\n       ```",
      "<div>\n\n## Cloving status\n- Pull request #1: partial. Remaining: HTML example.\n\n</div>",
      "| Heading | Value |\n| --- | --- |\n| ## Cloving status | - Pull request #1: partial. |",
      "Unclosed fence:\n```text\n## Cloving status",
      "<!-- an unclosed HTML comment",
    ];
    for (const body of examples) {
      scene.plan({
        scores: [],
        issues: [
          { ...original, body: statusBody(body, { partialRuns: earlier }) },
        ],
      });
      const report = await scene.perform(worker, {
        method: "partial-issue",
        payload,
      });
      assert.equal(
        report.outcome,
        "completed",
        JSON.stringify({ body, report }),
      );
      assert.equal(
        scene.state().issues[0]?.["body"],
        statusBody(body, {
          partialRuns: [
            ...earlier,
            { pullRequest: 7, remaining: payload.remaining },
          ],
        }),
      );
      assert.deepEqual(scene.state().issues[0]?.["labels"], [
        "keep",
        "cloving: ready",
      ]);
    }
  }));

await test("CLV-123 JSON comment escapes double hyphens and greater-than signs and round-trips exact items on retry", () =>
  withGithub(async (scene) => {
    const remaining = [
      'Keep --, ---, ----, > and --> plus "quotes" and \\backslashes.',
      "Keep <!-- cloving-status text.",
    ];
    scene.plan({ scores: [], issues: [{ ...original, body: "Original." }] });
    const worker = scene.worker(settings);
    for (const attempt of [1, 2]) {
      const report = await scene.perform(worker, {
        method: "partial-issue",
        payload: { ...payload, remaining },
      });
      assert.equal(report.outcome, "completed", String(attempt));
      const body = String(scene.state().issues[0]?.["body"]);
      const json = body.slice(
        body.lastIndexOf("<!-- cloving-status\n") +
          "<!-- cloving-status\n".length,
        body.lastIndexOf("\n-->"),
      );
      assert.doesNotMatch(json, /--|>/);
      assert.match(json, /\\u002d\\u002d/);
      assert.match(json, /\\u003e/);
      assert.deepEqual(JSON.parse(json), {
        version: 1,
        partialRuns: [{ pullRequest: 7, remaining }],
      });
      assert.equal(
        body,
        statusBody("Original.", {
          partialRuns: [{ pullRequest: 7, remaining }],
        }),
      );
    }
    assert.equal(
      scene.state().calls.filter((call) => call.includes("PATCH")).length,
      1,
    );
  }));

for (const method of ["partial-issue", "close-issue"])
  await test(`CLV-123 ${method} replaces incomplete terminal metadata without parsing Markdown`, () =>
    withGithub(async (scene) => {
      const worker = scene.worker(settings);
      for (const block of [
        "<!-- cloving-status",
        "<!-- cloving-status\n{broken}",
        "<!-- cloving-status -->",
      ]) {
        const outside = "Unclosed fence:\n```text\n\n";
        scene.plan({
          scores: [],
          issues: [{ ...original, body: outside + block }],
        });
        const report = await scene.perform(worker, { method, payload });
        assert.equal(
          report.outcome,
          "completed",
          JSON.stringify({ block, report }),
        );
        assert.equal(
          scene.state().issues[0]?.["body"],
          statusBody(outside, {
            partialRuns:
              method === "partial-issue"
                ? [{ pullRequest: 7, remaining: payload.remaining }]
                : [],
            completedPullRequest: method === "close-issue" ? 7 : undefined,
          }),
        );
      }
    }));
