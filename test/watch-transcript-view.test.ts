import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import {
  Transcript,
  type TranscriptControls,
  type TranscriptView,
} from "../src/cli/watch-transcript-view.ts";
import { watchHash, watchLocation } from "../src/cli/watch-navigation.ts";
import type { WatchTurn } from "../src/cli/watch-render.ts";
import type { TranscriptEntry } from "../src/turn-transcript.ts";
import { found, rendered } from "./watch-dom.ts";
import { entry } from "./turn-transcript-fixture.ts";
import { at, sampleRun, sampleTurn } from "./watch-sample.ts";

const operationId = '["cloving-operation",1,"run-1","work","effect",1,null]';

function turnOf(outcome: string): WatchTurn {
  const [turn] = sampleRun().turns;
  assert.ok(turn !== undefined);
  return { ...turn, operationId, outcome };
}

function shown(
  view: Partial<TranscriptView>,
  options: {
    readonly outcome?: string;
    readonly turnId?: string;
    readonly later?: readonly WatchTurn[];
  } = {},
) {
  const asked: unknown[] = [];
  const controls: TranscriptControls = {
    tab: "transcript",
    onTab: () => undefined,
    view: (target) => {
      asked.push(target);
      return {
        shown: true,
        expanded: false,
        entries: [],
        state: "open",
        message: "",
        earlier: false,
        unseen: 0,
        detached: false,
        ...view,
      };
    },
    onToggle: () => undefined,
    onExpand: () => undefined,
    onLink: () => undefined,
    onScroll: () => undefined,
    onJump: () => undefined,
    onEarlier: () => undefined,
    onRetry: () => undefined,
  };
  const turn = turnOf(options.outcome ?? "in work");
  const html = rendered(
    component(Transcript, {
      run: { runId: "run-1", turns: [turn, ...(options.later ?? [])] },
      turn,
      turnId: options.turnId ?? null,
      now: "2026-10-13T21:40:00.000Z",
      controls,
    }),
  );
  return { html, asked };
}

function entries(...items: readonly TranscriptEntry[]): string {
  return shown({ entries: items }).html;
}

await test("CLV-329 CLV-355 a transcript section shows assistant text with its Markdown and its HTML as text, a tool call in one line that opens to the full input, and closed thinking", () => {
  const html = entries(
    entry(1, { kind: "assistant", text: "**Bold** <b>tag</b>" }),
    entry(2, {
      kind: "tool-call",
      tool: "Bash",
      summary: "Bash: npm test",
      text: '{\n  "command": "npm test"\n}',
    }),
    entry(3, { kind: "thinking", text: "Plan the test." }),
  );
  assert.match(
    html,
    /<div class="entry assistant"><span class="mark">⏺<\/span><div class="markdown"><p><strong>Bold<\/strong> &lt;b&gt;tag&lt;\/b&gt;<\/p><\/div><\/div>/,
  );
  assert.match(
    html,
    /<details class="tool-line"><summary><span class="mark">⏺<\/span> <strong class="tool-name">Bash<\/strong>\(npm test\)<\/summary><pre class="tool-input">\{\n {2}&quot;command&quot;: &quot;npm test&quot;\n\}<\/pre><\/details>/,
  );
  assert.match(
    html,
    /<details class="entry thinking"><summary>✻ Thinking…<\/summary><pre>Plan the test\.<\/pre><\/details>/,
  );
  assert.doesNotMatch(html, /<b>|open/);
});

await test("CLV-341 a tool result is folded to a line with an error mark and its line count, and opens to all its lines and the count of bytes that the cut left out", () => {
  const text = Array.from(
    { length: 7 },
    (_, index) => `line ${String(index + 1)}`,
  ).join("\n");
  const html = entries(
    entry(1, { kind: "tool-result", text, error: true, omittedBytes: 512 }),
  );
  assert.ok(
    html.includes(
      `<details class="entry tool-result error"><summary><span class="gutter">⎿</span> Error · 7 lines</summary><div class="output"><pre>line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7</pre><p class="entry-cut">The output is cut: 512 bytes are left out.</p></div></details>`,
    ),
    html,
  );
});

await test("CLV-329 the attempt line, a notice and the result show as lines", () => {
  const html = entries(
    entry(1, {
      kind: "notice",
      attempt: 2,
      text: "Attempt 2 (resumed after a restart)",
    }),
    entry(2, { kind: "result", text: "Turn end: success · cost 0.42 USD" }),
  );
  assert.match(
    html,
    /<div class="entry notice"><pre>Attempt 2 \(resumed after a restart\)<\/pre><\/div><div class="entry result"><pre>Turn end: success · cost 0\.42 USD<\/pre><\/div>/,
  );
});

await test("CLV-329 each transcript has a link to the run detail with the turn, a button to hide it and a scroll box for the entries", () => {
  const { html, asked } = shown({});
  const link = watchHash({
    workflowId: null,
    runId: "run-1",
    turnId: operationId,
  });
  assert.equal(link, `#run=run-1&turn=${encodeURIComponent(operationId)}`);
  assert.ok(
    html.includes(
      `<a class="transcript-link" href="${link.replaceAll("&", "&amp;")}">Link</a>`,
    ),
    html,
  );
  assert.match(
    html,
    /<button type="button" class="transcript-toggle">Hide<\/button>/,
  );
  assert.ok(
    html.includes(
      `<div class="transcript-lines" data-transcript="${operationId.replaceAll('"', "&quot;")}">`,
    ),
  );
  assert.deepEqual(asked, [{ runId: "run-1", operationId, wanted: true }]);
});

await test("CLV-329 an ended turn before the last turn asks for a closed transcript unless the link names it", () => {
  const later = [sampleTurn({ startedAt: at("21:40:00"), outcome: "failed" })];
  assert.deepEqual(
    shown({ shown: false }, { outcome: "completed", later }).asked,
    [{ runId: "run-1", operationId, wanted: false }],
  );
  const linked = shown(
    { shown: false },
    { outcome: "completed", turnId: operationId, later },
  );
  assert.deepEqual(linked.asked, [
    { runId: "run-1", operationId, wanted: true },
  ]);
  assert.match(linked.html, /class="transcript-toggle">Show<\/button>/);
  assert.doesNotMatch(linked.html, /transcript-lines/);
});

await test("CLV-329 a transcript that is not kept, a failed read, earlier entries and new entries below the view show their lines and buttons", () => {
  assert.match(
    shown({ state: "not-kept" }).html,
    /<p class="meta">The transcript of this turn is not kept\.<\/p>/,
  );
  assert.match(
    shown({ state: "failed", message: "The run has no agent turn." }).html,
    /<p class="bad">The run has no agent turn\.<\/p><button type="button" class="transcript-retry">Retry<\/button>/,
  );
  assert.match(
    shown({ state: "loading" }).html,
    /<p class="meta">The transcript loads\.<\/p>/,
  );
  assert.match(
    shown({ state: "ended" }).html,
    /<p class="meta">The transcript has no entries\.<\/p>/,
  );
  const html = shown({ earlier: true, unseen: 3 }).html;
  assert.match(
    html,
    /<button type="button" class="transcript-earlier">Load earlier entries<\/button><div class="transcript-lines"/,
  );
  assert.match(
    html,
    /<button type="button" class="transcript-jump">Jump to the end · 3 new entries<\/button>/,
  );
  assert.match(shown({ unseen: 1 }).html, />Jump to the end · 1 new entry</);
  assert.match(
    shown({ detached: true }).html,
    /<button type="button" class="transcript-jump">Jump to the end<\/button>/,
  );
});

await test("CLV-329 the hash of a run detail can name a turn", () => {
  assert.deepEqual(
    watchLocation(`#run=run-1&turn=${encodeURIComponent(operationId)}`),
    {
      workflowId: null,
      runId: "run-1",
      turnId: operationId,
    },
  );
  assert.deepEqual(watchLocation("#run=run-1"), {
    workflowId: null,
    runId: "run-1",
  });
});

function listener(value: unknown): value is (event: unknown) => void {
  return typeof value === "function";
}

function handler(
  props: Readonly<Record<string, unknown>> | undefined,
  name: string,
): (event: unknown) => void {
  const callback = props?.[name];
  assert.ok(listener(callback));
  return callback;
}

await test("CLV-329 CLV-355 the buttons and the scroll box of a transcript call their controls", () => {
  const calls: unknown[] = [];
  const controls: TranscriptControls = {
    tab: "transcript",
    onTab: () => undefined,
    view: () => ({
      shown: true,
      expanded: false,
      entries: [entry(1, { kind: "assistant", text: "a" })],
      state: "open",
      message: "",
      earlier: true,
      unseen: 2,
      detached: false,
    }),
    onToggle: (target) => calls.push(["toggle", target.operationId]),
    onExpand: (target) => calls.push(["expand", target.operationId]),
    onLink: (target) => calls.push(["link", target.operationId]),
    onScroll: (turn, box) => calls.push(["scroll", turn, box.scrollTop]),
    onJump: (target) => calls.push(["jump", target.operationId]),
    onEarlier: (target) => calls.push(["earlier", target.operationId]),
    onRetry: (target) => calls.push(["retry", target.operationId]),
  };
  const tree = component(Transcript, {
    run: { runId: "run-1", turns: [] },
    turn: turnOf("in work"),
    turnId: null,
    now: "2026-10-13T21:40:00.000Z",
    controls,
  });
  for (const button of found(tree, "button")) handler(button, "onClick")({});
  handler(found(tree, "a")[0], "onClick")({});
  const box = found(tree, "div").find(
    (props) => props["class"] === "transcript-lines",
  );
  handler(
    box,
    "onScroll",
  )({
    currentTarget: { scrollTop: 40, clientHeight: 10, scrollHeight: 90 },
  });
  assert.deepEqual(calls, [
    ["toggle", operationId],
    ["expand", operationId],
    ["earlier", operationId],
    ["jump", operationId],
    ["link", operationId],
    ["scroll", operationId, 40],
  ]);
  const plain = component(Transcript, {
    run: { runId: "run-1", turns: [] },
    turn: turnOf("completed"),
    turnId: null,
    now: "2026-10-13T21:40:00.000Z",
    controls: undefined,
  });
  handler(found(plain, "button")[0], "onClick")({});
  handler(found(plain, "a")[0], "onClick")({});
  assert.match(rendered(plain), /class="transcript-toggle">Show</);
});

await test("CLV-329 the Retry button of a failed transcript read calls its control", () => {
  const calls: unknown[] = [];
  const controls: TranscriptControls = {
    tab: "transcript",
    onTab: () => undefined,
    view: () => ({
      shown: true,
      expanded: false,
      entries: [],
      state: "failed",
      message: "The watch tool does not answer.",
      earlier: false,
      unseen: 0,
      detached: false,
    }),
    onToggle: () => undefined,
    onExpand: () => undefined,
    onLink: () => undefined,
    onScroll: () => undefined,
    onJump: () => undefined,
    onEarlier: () => undefined,
    onRetry: (target) => calls.push(["retry", target.operationId]),
  };
  const failed = component(Transcript, {
    run: { runId: "run-1", turns: [] },
    turn: turnOf("in work"),
    turnId: null,
    now: "2026-10-13T21:40:00.000Z",
    controls,
  });
  const retry = found(failed, "button").find(
    (props) => props["class"] === "transcript-retry",
  );
  handler(retry, "onClick")({});
  assert.deepEqual(calls, [["retry", operationId]]);
});
