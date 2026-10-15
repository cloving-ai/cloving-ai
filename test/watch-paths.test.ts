import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { component } from "../src/cli/watch-element.ts";
import { Page } from "../src/cli/watch-view.ts";
import { boardModel, boardRun } from "./watch-board-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { noCopy, sampleTurn } from "./watch-sample.ts";

const home = "/fixture/home";
const worktree = `${home}/worktrees/79-d6730fd0`;
const outside = "/fixture/other-tree";

function modelWithPaths(
  text: string,
  client = `CLOVING_RUNTIME_DIR=${home}/runtime cloving`,
) {
  const run = boardRun("run-1");
  return boardModel(
    [
      {
        ...run,
        status: {
          ...record(run["status"]),
          title: text,
          reason: { detail: text },
          feedback: [{ text }],
        },
      },
    ],
    {
      home,
      client,
      decisions: [
        { runId: "run-1", decisionId: "run-1/review-1", prompt: text },
      ],
      turns: [
        sampleTurn({
          worktree,
          activity: [{ kind: "tool", text }],
          summary: text,
          commits: [text],
          files: [text],
          uncommitted: [text],
        }),
        sampleTurn({ key: "other", worktree: outside }),
      ],
    },
  );
}

await test("CLV-079 the model makes run text relative to every worktree and hides home paths", () => {
  const text = `Read ${worktree}/src/a.ts in ${worktree}; check ${home}/notes. Also (${outside}/test.ts), ${outside}.`;
  const expected = "Read src/a.ts in .; check ~/notes. Also (test.ts), ..";
  const model = modelWithPaths(text);
  const run = model.runs[0];
  assert.ok(run);
  const turn = run.turns[0];
  assert.ok(turn);
  assert.deepEqual(
    [
      run.title,
      run.detail,
      run.decisions[0]?.prompt,
      run.feedback[0]?.text,
      turn.activity[0]?.text,
      turn.summary,
      ...turn.commits,
      ...turn.files,
      ...turn.uncommitted,
    ],
    Array<string>(9).fill(expected),
  );
  assert.equal(turn.worktree, "79-d6730fd0");
  assert.equal(run.turns[1]?.worktree, "other-tree");
  assert.equal(Object.hasOwn(model, "host"), false);
  assert.equal(model.workflows[0]?.columns[0]?.cards[0]?.title, expected);
});

await test("CLV-079 folder boundaries include punctuation but preserve different folder names", () => {
  for (const ending of [
    "",
    "/file",
    " ",
    "\n",
    "'",
    '"',
    ")",
    ",",
    ":",
    ";",
    ".",
    ". ",
  ]) {
    assert.equal(
      modelWithPaths(`${home}${ending}`).runs[0]?.detail,
      `~${ending}`,
    );
  }
  for (const text of [
    "/elsewhere/file",
    `${home}+other/file`,
    `${home}.other/file`,
    `${home}-other/file`,
    `${worktree}+other/file`,
  ]) {
    const expected = text.startsWith(worktree) ? text.replace(home, "~") : text;
    assert.equal(modelWithPaths(text).runs[0]?.detail, expected);
  }
});

await test("CLV-079 copied commands only shorten home paths and retain runtime selection in the shell", () => {
  const client = `CLOVING_RUNTIME_DIR=${home}/runtime cloving ${worktree}/file ${outside}/file ${home}+other/file`;
  const decision = modelWithPaths("Review", client).runs[0]?.decisions[0];
  assert.ok(decision);
  const prefix = `CLOVING_RUNTIME_DIR=~/runtime cloving ~/worktrees/79-d6730fd0/file ${outside}/file ${home}+other/file`;
  assert.ok(decision.approve.startsWith(`${prefix} approve`));
  assert.ok(decision.deny.startsWith(`${prefix} deny`));
  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      `cloving() { printf '%s' "$CLOVING_RUNTIME_DIR"; }; ${decision.approve}`,
    ],
    { env: { ...process.env, HOME: home }, cwd: "/", encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${home}/runtime`);
});

await test("CLV-079 the rendered full page contains no home folder from turns, decisions or run detail", () => {
  const model = modelWithPaths(`${worktree}/src/a.ts ${home}/notes`);
  const html = rendered(
    component(Page, {
      model,
      selected: "run-1",
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
    }),
  );
  assert.doesNotMatch(html, /\/fixture\/home/);
  assert.ok(html.includes("79-d6730fd0"));
});

await test("CLV-079 unrelated absolute paths containing home or worktree names stay unchanged", () => {
  for (const path of [
    `/archive${home}/file`,
    `/archive${worktree}/file`,
    `/archive${outside}/file`,
  ]) {
    const model = modelWithPaths(path, `CLOVING_RUNTIME_DIR=${path} cloving`);
    assert.equal(model.runs[0]?.detail, path);
    assert.ok(
      model.runs[0].decisions[0]?.approve.startsWith(
        `CLOVING_RUNTIME_DIR=${path} cloving approve`,
      ),
    );
  }
});

await test("CLV-079 a worktree with a trailing slash still displays the current directory", () => {
  for (const ending of ["", " ", ")", ".", ". "]) {
    assert.equal(
      modelWithPaths(`Inspect (${outside}/${ending}`).runs[0]?.detail,
      `Inspect (.${ending}`,
    );
  }
});

await test("CLV-079 Markdown and quoted paths hide home and worktree folders", () => {
  for (const before of ["`", "[", "{", "<", '"', "'"]) {
    const text = `${before}${worktree}/src/a.ts ${before}${home}/notes`;
    assert.equal(
      modelWithPaths(text).runs[0]?.detail,
      `${before}src/a.ts ${before}~/notes`,
    );
  }
});
