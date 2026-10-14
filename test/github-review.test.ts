import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findingsOf,
  reviewLimits,
  reviewer,
  scoreOf,
} from "../src/daemon/github-calls.ts";

const commit = "a".repeat(40);
const older = "b".repeat(40);
const user = { login: reviewer };
const link = "https://github.com/acme/demo/commit/";

function summary(score: number, reviewed: string): string {
  return `<h2>Confidence Score: ${String(score)}/5</h2>\n<!-- greptile_confidence_score:${String(score)} -->\n<sub>Last reviewed commit: ["Fix it"](${link}${reviewed})</sub>`;
}

function finding(
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    user,
    original_commit_id: commit,
    path: "src/a.ts",
    line: 4,
    body: "Check the bound.",
    ...fields,
  };
}

await test("CLV-063 the review reader takes the score and the summary of the last Greptile summary of the commit, with no HTML comments", () => {
  const comments = [
    { user, body: summary(2, commit) },
    { user: { login: "someone" }, body: summary(1, commit) },
    { user, body: summary(4, commit.slice(0, 7)) },
    { user, body: "<!-- greptile_confidence_score:3 --> no commit" },
    { user, body: `Last reviewed commit: [x](${link}${commit}) no score` },
    { user, body: summary(5, older) },
  ];
  assert.deepEqual(scoreOf(comments, commit), {
    score: 4,
    summary: `<h2>Confidence Score: 4/5</h2>\n\n<sub>Last reviewed commit: ["Fix it"](${link}aaaaaaa)</sub>`,
  });
  assert.equal(scoreOf(comments, "c".repeat(40)), undefined);
  assert.equal(scoreOf({ message: "Not Found" }, commit), undefined);
  const long = scoreOf(
    [{ user, body: `${summary(3, commit)}${"x".repeat(9_000)}` }],
    commit,
  );
  assert.equal(long?.summary.length, reviewLimits.summaryCharacters);
});

await test("CLV-063 the review reader gives the Greptile findings of the commit with their place, and skips replies, earlier commits and other users", () => {
  const comments = [
    finding({}),
    finding({ line: null, original_line: 9, body: "Outdated." }),
    finding({ line: null, body: "No line." }),
    finding({ in_reply_to_id: 1, body: "A reply." }),
    finding({ original_commit_id: older }),
    finding({ user: { login: "someone" } }),
  ];
  assert.deepEqual(findingsOf(comments, commit), [
    { path: "src/a.ts", line: 4, body: "Check the bound." },
    { path: "src/a.ts", line: 9, body: "Outdated." },
    { path: "src/a.ts", line: null, body: "No line." },
  ]);
  assert.deepEqual(findingsOf("not a list", commit), []);
});

await test("CLV-063 the review reader cuts a long finding and keeps the findings in the byte limit", () => {
  const many = Array.from({ length: 10 }, () =>
    finding({ body: "y".repeat(5_000) }),
  );
  const kept = findingsOf(many, commit);
  assert.equal(kept[0]?.body.length, reviewLimits.findingCharacters);
  assert.equal(kept.length, 3);
  assert.ok(
    kept.reduce(
      (bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item)),
      0,
    ) <= reviewLimits.findingsBytes,
  );
});
