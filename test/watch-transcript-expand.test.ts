import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import {
  Transcript,
  type TranscriptControls,
} from "../src/cli/watch-transcript-view.ts";
import { entry } from "./turn-transcript-fixture.ts";
import { found, rendered } from "./watch-dom.ts";
import { sampleTurn } from "./watch-sample.ts";

function clickHandler(value: unknown): value is (event: unknown) => void {
  return typeof value === "function";
}

const turn = sampleTurn({ operationId: "operation-1", outcome: "completed" });

function controlsOf(view: {
  readonly shown: boolean;
  readonly expanded: boolean;
  readonly calls: string[];
}): TranscriptControls {
  return {
    tab: "transcript",
    onTab: () => undefined,
    view: () => ({
      shown: view.shown,
      expanded: view.expanded,
      entries: [entry(1, { kind: "assistant", text: "a" })],
      state: "ended",
      message: "",
      earlier: false,
      unseen: 0,
      detached: false,
    }),
    onToggle: () => undefined,
    onExpand: (target) => view.calls.push(target.operationId),
    onLink: () => undefined,
    onScroll: () => undefined,
    onJump: () => undefined,
    onEarlier: () => undefined,
    onRetry: () => undefined,
  };
}

function shown(
  controls: TranscriptControls,
  layout?: "terminal",
): ReturnType<typeof component> {
  return component(Transcript, {
    run: { runId: "run-1", turns: [turn] },
    turn,
    turnId: null,
    now: "2026-10-13T21:40:00.000Z",
    controls,
    ...(layout === undefined ? {} : { layout }),
  });
}

await test("CLV-355 an open turn has an expand button at the right end of its head, after Full screen, and its lines area has the cap", () => {
  const html = rendered(
    shown(controlsOf({ shown: true, expanded: false, calls: [] })),
  );
  assert.match(
    html,
    /Full screen<\/a><button type="button" class="transcript-expand" title="Expand transcript" aria-label="Expand transcript" aria-expanded="false">⤢<\/button><\/div>/,
  );
  assert.match(html, /<div class="transcript-lines" data-transcript=/);
});

await test("CLV-355 an expanded turn has a collapse button and a lines area with no cap, and a click on the button calls the expand control of the turn", () => {
  const calls: string[] = [];
  const tree = shown(controlsOf({ shown: true, expanded: true, calls }));
  const html = rendered(tree);
  assert.match(
    html,
    /<button type="button" class="transcript-expand" title="Collapse transcript" aria-label="Collapse transcript" aria-expanded="true">⤡<\/button><\/div>/,
  );
  assert.match(html, /<div class="transcript-lines expanded" data-transcript=/);
  const button = found(tree, "button").find(
    (props) => props["class"] === "transcript-expand",
  );
  const click = button?.["onClick"];
  assert.ok(clickHandler(click));
  click({});
  assert.deepEqual(calls, ["operation-1"]);
});

await test("CLV-355 a hidden turn and the full-screen view have no expand button", () => {
  const hidden = rendered(
    shown(controlsOf({ shown: false, expanded: false, calls: [] })),
  );
  const full = rendered(
    shown(controlsOf({ shown: true, expanded: false, calls: [] }), "terminal"),
  );
  assert.doesNotMatch(hidden, /transcript-expand/);
  assert.doesNotMatch(full, /transcript-expand/);
});
