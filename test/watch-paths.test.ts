import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { component } from "../src/cli/watch-element.ts";
import { turnOf } from "../src/cli/watch-model.ts";
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

await test("CLV-080 the model makes worktree file addresses relative", () => {
  const text = `✖ at TestContext.<anonymous> (file://${worktree}/test/watch-paths.test.ts:13:9)`;
  const model = modelWithPaths(text);
  assert.equal(
    model.runs[0]?.turns[0]?.activity[0]?.text,
    "✖ at TestContext.<anonymous> (test/watch-paths.test.ts:13:9)",
  );
});

await test("CLV-080 file addresses hide home folders and preserve unrelated folders", () => {
  const text = `file://${home}/notes/a.ts:4:2 file:///elsewhere/a.ts:5:3 file:///archive${worktree}/a.ts`;
  assert.equal(
    modelWithPaths(text).runs[0]?.turns[0]?.activity[0]?.text,
    `~/notes/a.ts:4:2 file:///elsewhere/a.ts:5:3 file:///archive${worktree}/a.ts`,
  );
});

type ActivityMessage =
  | {
      type: "assistant" | "user";
      message: {
        content: (
          | { type: "text"; text: string }
          | { type: "tool_result"; is_error: boolean; content: string }
          | { type: "tool_use"; name: string; input: { command: string } }
        )[];
      };
    }
  | { type: "result"; result: string; total_cost_usd?: number };

function activityModel(message: ActivityMessage) {
  const turn = turnOf({
    key: "activity",
    started: {
      operationId: JSON.stringify(["cloving-operation", 1, "run-1"]),
      worktree,
    },
    result: null,
    lines: [JSON.stringify(message)],
  });
  return boardModel([boardRun("run-1")], { home, turns: [turn] });
}

await test("CLV-080 activity hides a home folder crossing the text limit before shortening", () => {
  const prefix = `${"x".repeat(593)} `;
  const text = `${prefix}${home}/notes ${"y".repeat(700)}`;
  const model = activityModel({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
  const shown = model.runs[0]?.turns[0]?.activity[0]?.text;
  assert.equal(shown, `${prefix}~/note…`);
});

await test("CLV-080 activity hides a home folder ending at the text limit", () => {
  const prefix = `${"x".repeat(599 - home.length)} `;
  const text = `${prefix}${home}/notes ${"y".repeat(700)}`;
  const model = activityModel({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
  assert.equal(
    model.runs[0]?.turns[0]?.activity[0]?.text,
    `${prefix}~/notes yyyyy…`,
  );
});

await test("CLV-080 long errors and tool calls replace file addresses before shortening", () => {
  const text = `✖ at TestContext.<anonymous> (file://${worktree}/test/watch-paths.test.ts:13:9) ${"x".repeat(700)}`;
  for (const content of [
    { type: "tool_result", is_error: true, content: text },
    { type: "tool_use", name: "Bash", input: { command: text } },
  ] as const) {
    const model = activityModel({
      type: content.type === "tool_result" ? "user" : "assistant",
      message: { content: [content] },
    });
    const shown = model.runs[0]?.turns[0]?.activity[0]?.text;
    assert.ok(shown);
    assert.ok(shown.includes("(test/watch-paths.test.ts:13:9)"));
    assert.doesNotMatch(shown, /file:\/\/|\/fixture\/home/);
    assert.equal(shown.length, 601);
    assert.ok(shown.endsWith("…"));
  }
});

await test("CLV-080 long results hide paths before shortening and keep costs at the end", () => {
  const prefix = `${"x".repeat(593)} `;
  const model = activityModel({
    type: "result",
    result: `${prefix}${worktree}/test.ts ${"y".repeat(700)}`,
    total_cost_usd: 1.25,
  });
  assert.deepEqual(model.runs[0]?.turns[0]?.activity, [
    { kind: "result", text: `${prefix}test.t… (cost Price not known)` },
  ]);
});

await test("CLV-080 the model keeps the text limit after path replacement without requiring a cost", () => {
  for (const length of [599, 600, 601]) {
    const result = `${home}/${"x".repeat(length - 2)}`;
    const model = activityModel({ type: "result", result });
    const expected = `~/${"x".repeat(Math.min(length, 600) - 2)}`;
    assert.deepEqual(model.runs[0]?.turns[0]?.activity, [
      {
        kind: "result",
        text: `${length > 600 ? `${expected}…` : expected} (cost Price not known)`,
      },
    ]);
  }
});

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
