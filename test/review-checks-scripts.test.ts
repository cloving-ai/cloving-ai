import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { withFiles } from "./quality/files-fixture.ts";
import { record } from "../src/protocol.ts";

const scripts = join(
  import.meta.dirname,
  "../templates/review-checks/review-checks",
);
const fake = `#!/usr/bin/env -S -u NODE_V8_COVERAGE ${process.execPath}\n`;
const fakeGh = `${fake}const args = process.argv.slice(2);
if (!process.env.GH_CONFIG_DIR?.endsWith("/gh-login")) { process.stderr.write("not logged in"); process.exit(1); }
const now = new Date().toISOString();
const row = { id: 1, path: "src/queue.ts", line: 4, body: "Await this.", html_url: "https://github.com/acme/demo/pull/9#discussion_r1", user: { login: "greptile-apps[bot]", type: "Bot" } };
if (args[0] === "pr") process.stdout.write(JSON.stringify([{ number: 9, url: "u", mergedAt: now }]));
else if (args[3].includes("/pulls/9/")) process.stdout.write(JSON.stringify([[row]]));
else process.stdout.write(JSON.stringify([[]]));
`;
const fakeEslint = `${fake}process.stdout.write(JSON.stringify({ rules: { "no-console": [2] } }));\n`;

function environment(directory: string): NodeJS.ProcessEnv {
  return {
    PATH: `${join(directory, "bin")}${delimiter}${process.env["PATH"] ?? ""}`,
    HOME: directory,
    CLOVING_RUN_ID: "run-9",
  };
}

const scriptFiles = {
  "bin/gh": fakeGh,
  "repo/node_modules/.bin/eslint": fakeEslint,
  "repo/quality/clones.ts": "",
  "gh-login/hosts.yml": "",
};

async function commentsScript(directory: string) {
  await chmod(join(directory, "bin/gh"), 0o755);
  await chmod(join(directory, "repo/node_modules/.bin/eslint"), 0o755);
  return (commandArguments: readonly string[], folder = "repo") =>
    spawnSync(
      process.execPath,
      [join(scripts, "review-comments.mts")].concat(commandArguments),
      {
        cwd: join(directory, folder),
        encoding: "utf8",
        env: environment(directory),
      },
    );
}

await test("CLV-316 the review-comments script reads gh with the given login folder and prints the facts", () =>
  withFiles(scriptFiles, async (directory) => {
    const run = await commentsScript(directory);
    const decisions = join(directory, "review-checks.jsonl");
    const printed = run([join(directory, "gh-login"), decisions]);
    assert.equal(printed.status, 0, printed.stderr);
    const facts = record(JSON.parse(printed.stdout));
    assert.deepEqual(facts?.["comments"], [
      {
        pullRequest: 9,
        path: "src/queue.ts",
        line: 4,
        author: "greptile-apps[bot]",
        bot: true,
        text: "Await this.",
        url: "https://github.com/acme/demo/pull/9#discussion_r1",
      },
    ]);
    assert.deepEqual(facts["lintRules"], { "no-console": "error" });
    assert.deepEqual(facts["qualityChecks"], ["clones"]);
    assert.deepEqual(facts["decisions"], []);
    const other = run([join(directory, "repo"), decisions]);
    assert.equal(other.status, 1);
    assert.match(other.stderr, /not logged in/);
    assert.equal(run([]).status, 1);
  }));

await test("CLV-316 the review-comments script works with no ESLint or quality folder and stops on a folder as decisions file", () =>
  withFiles(scriptFiles, async (directory) => {
    const run = await commentsScript(directory);
    const login = join(directory, "gh-login");
    const bare = run([login, join(directory, "none.jsonl")], "bin");
    assert.equal(bare.status, 0, bare.stderr);
    const empty = record(JSON.parse(bare.stdout));
    assert.deepEqual(
      [empty?.["lintRules"], empty?.["qualityChecks"]],
      [{}, []],
    );
    const folderDecisions = run([login, directory]);
    assert.equal(folderDecisions.status, 1);
    assert.match(folderDecisions.stderr, /EISDIR/);
  }));

await test("CLV-316 the review-checks-record script appends the decisions of each run with its run ID", () =>
  withFiles({ "bin/.keep": "" }, async (directory) => {
    const file = join(directory, "review-checks.jsonl");
    const input = JSON.stringify({
      decisions: [
        {
          name: "await-in-loop",
          kind: "enable-rule",
          rule: "no-await-in-loop",
          shape: "Shape.",
          decision: "reject",
          links: [],
        },
      ],
    });
    for (const round of [1, 2]) {
      const ended = spawnSync(
        process.execPath,
        [join(scripts, "review-checks-record.mts"), file],
        {
          encoding: "utf8",
          input,
          env: Object.assign(environment(directory), {
            CLOVING_RUN_ID: round === 1 ? undefined : "run-9",
          }),
        },
      );
      assert.equal(ended.status, 0, `${String(round)} ${ended.stderr}`);
      assert.equal(ended.stdout, '{"recorded":1}\n');
    }
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(record(JSON.parse(lines[0] ?? "{}"))?.["runId"], null);
    assert.equal(record(JSON.parse(lines[1] ?? "{}"))?.["runId"], "run-9");
    assert.match(
      String(record(JSON.parse(lines[0] ?? "{}"))?.["decidedAt"]),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  }));
