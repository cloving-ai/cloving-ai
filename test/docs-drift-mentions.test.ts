import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changedWords,
  docPatterns,
  mentionedCode,
  namedDocs,
} from "../templates/docs-drift/docs-drift/doc-mentions.mts";

const diff = [
  "diff --git a/src/settings.ts b/src/settings.ts",
  "index 1111111..2222222 100644",
  "--- a/src/settings.ts",
  "+++ b/src/settings.ts",
  "@@ -17 +17 @@",
  '-  queueSeconds: 30, // "queue.seconds"',
  '+  return config.queue.seconds ?? 60; // "invalid-queue-seconds"',
  "diff --git a/src/old.ts b/src/old.ts",
  "deleted file mode 100644",
  "--- a/src/old.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const CLOVING_OLD = 1;",
  "diff --git a/templates/x/x/run.mts b/templates/x/x/run.mts",
  "--- a/templates/x/x/run.mts",
  "+++ b/templates/x/x/run.mts",
  "@@ -3 +3 @@",
  "+const a = 1;",
  "diff --git a/src/quiet.ts b/src/quiet.ts",
  "@@ -1 +1 @@",
  "+maxBudgetUsd",
  "+}",
  'diff --git "a/src/\\350\\250\\255\\345\\256\\232.ts" "b/src/\\350\\250\\255\\345\\256\\232.ts"',
  "@@ -1 +1 @@",
  "+CLOVING_ODD",
  'diff --git "a/src/say \\"hi\\"\\t\\\\.ts" "b/src/say \\"hi\\"\\t\\\\.ts"',
  "@@ -1 +1 @@",
  "+CLOVING_QUOTE",
  "diff --git a/src/x b/y.ts b/src/x b/y.ts",
  "@@ -1 +1 @@",
  "+CLOVING_SPACE",
].join("\n");

await test("CLV-317 changedWords maps each changed code file to the words of its added and removed lines", () => {
  const changed = changedWords(diff);
  assert.deepEqual(
    [...changed.keys()],
    [
      "src/settings.ts",
      "src/old.ts",
      "templates/x/x/run.mts",
      "src/quiet.ts",
      "src/\u8a2d\u5b9a.ts",
      'src/say "hi"\t\\.ts',
      "src/x b/y.ts",
    ],
  );
  const words = changed.get("src/settings.ts") ?? new Set();
  for (const word of [
    "queue.seconds",
    "config.queue.seconds",
    "seconds",
    "invalid-queue-seconds",
    "queueSeconds",
  ])
    assert.ok(words.has(word), word);
  assert.ok(!words.has("b"));
  assert.ok(!words.has("src/settings.ts"));
  assert.ok(changed.get("src/old.ts")?.has("CLOVING_OLD"));
  assert.ok(!changed.get("src/quiet.ts")?.has("CLOVING_ODD"));
  assert.ok(changed.get("src/\u8a2d\u5b9a.ts")?.has("CLOVING_ODD"));
  assert.ok(changed.get('src/say "hi"\t\\.ts')?.has("CLOVING_QUOTE"));
  assert.ok(changed.get("src/x b/y.ts")?.has("CLOVING_SPACE"));
});

await test("CLV-317 mentionedCode gives the changed files that a doc names by path or by a code name", () => {
  const changed = changedWords(diff);
  assert.deepEqual(
    mentionedCode(
      {
        path: "README.md",
        text: "Set `queue.seconds` (see src/old.ts). The `seconds` word and `maxBudgetUsd`, `CLOVING_NONE`.",
      },
      changed,
    ),
    ["src/old.ts", "src/quiet.ts", "src/settings.ts"],
  );
  assert.deepEqual(
    mentionedCode(
      {
        path: "templates/x/README.md",
        text: "Run `x/run.mts`. The script ./x/run.mts and `README.md`.",
      },
      changed,
    ),
    ["templates/x/x/run.mts"],
  );
  assert.deepEqual(
    mentionedCode({ path: "AGENTS.md", text: "Nothing `ab` here." }, changed),
    [],
  );
  assert.deepEqual(mentionedCode({ path: "A.md", text: "!" }, changed), []);
});

await test("CLV-317 docPatterns keeps the Markdown files that match an operator pattern", () => {
  const files = [
    "README.md",
    "AGENTS.md",
    "src/a.ts",
    "templates/x/README.md",
    "templates/x/deep/README.md",
    "templates/x/notes.txt",
    "docs/a b.md",
    "docs/guide.md",
  ];
  assert.deepEqual(docPatterns(files, ["README.md", "templates/*/README.md"]), [
    "README.md",
    "templates/x/README.md",
  ]);
  assert.deepEqual(docPatterns(files, ["docs/*", "src/a.ts", "AGENTS.?d"]), [
    "AGENTS.md",
    "docs/guide.md",
  ]);
});

await test("CLV-317 namedDocs gives the docs that the title of an open issue names", () => {
  const named = namedDocs([
    "Make `README.md` match the code on main",
    "Fix templates/x/README.md, please",
  ]);
  assert.ok(named.has("README.md"));
  assert.ok(named.has("templates/x/README.md"));
  assert.ok(!named.has("x/README.md"));
  assert.ok(!named.has("AGENTS.md"));
});
