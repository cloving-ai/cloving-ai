import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { watchHash, watchLocation } from "../src/cli/watch-navigation.ts";
import { Page } from "../src/cli/watch-view.ts";
import { themeTokens } from "../src/theme-tokens.ts";
import { rendered } from "./watch-dom.ts";
import { rule } from "./watch-style-fixture.ts";
import {
  noCopy,
  sampleModel,
  sampleRun,
  sampleTurn,
  wantedTranscripts,
} from "./watch-sample.ts";

const turn = sampleTurn({ operationId: "operation-1", outcome: "completed" });
const model = sampleModel([
  sampleRun({ runId: "run-1", state: "completed", turns: [turn] }),
]);

function page(selected: string): string {
  return rendered(
    component(Page, {
      model,
      selected,
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
      transcripts: wantedTranscripts,
    }),
  );
}

await test("CLV-333 the hash of a run detail can name the terminal view of a turn, and an unknown view is left out", () => {
  const location = {
    workflowId: null,
    runId: "run-1",
    turnId: "operation-1",
    view: "terminal",
  } as const;
  assert.equal(
    watchHash(location),
    "#run=run-1&turn=operation-1&view=terminal",
  );
  assert.deepEqual(
    watchLocation("#run=run-1&turn=operation-1&view=terminal"),
    location,
  );
  assert.deepEqual(watchLocation("#run=run-1&turn=operation-1&view=other"), {
    workflowId: null,
    runId: "run-1",
    turnId: "operation-1",
  });
});

await test("CLV-333 each transcript has a full-screen link, and the full-screen link shows only the terminal panel of that turn", () => {
  const detail = page("#run=run-1");
  assert.ok(
    detail.includes(
      '<a class="transcript-full" href="#run=run-1&amp;turn=operation-1&amp;view=terminal">Full screen</a>',
    ),
    detail,
  );
  const full = page("#run=run-1&turn=operation-1&view=terminal");
  assert.match(
    full,
    /^<div class="terminal-page"><section class="transcript code-window" data-turn="operation-1">/,
  );
  assert.ok(full.endsWith("</section></div>"), full);
  assert.doesNotMatch(full, /<header|class="banner|transcript-full/);
  assert.match(
    full,
    /<a class="transcript-link" href="#run=run-1&amp;turn=operation-1">Run detail<\/a>/,
  );
  assert.equal(
    page("#run=run-1&turn=operation-9&view=terminal"),
    '<div class="terminal-page"><p class="meta">This turn is not available.</p></div>',
  );
});

await test("CLV-333 the terminal panel has its own color tokens with dark defaults, and its rules take their colors from these tokens", () => {
  const names = ["background", "text", "dim", "red", "green", "tool"];
  for (const name of names)
    assert.deepEqual(themeTokens[`color.terminal.${name}`], { type: "color" });
  assert.match(
    rule(":root"),
    /--color-terminal-background: #141414; --color-terminal-text: #E6E6E6; --color-terminal-dim: #8C8C8C;\n\s*--color-terminal-red: #FF7B72; --color-terminal-green: #56D364; --color-terminal-tool: #FFFFFF;/,
  );
  assert.match(
    rule(".transcript.code-window"),
    /background: var\(--color-terminal-background\); color: var\(--color-terminal-text\);/,
  );
  assert.match(
    rule(".transcript-lines .added"),
    /color: var\(--color-terminal-green\)/,
  );
  assert.match(
    rule(".transcript-lines .tool-name"),
    /color: var\(--color-terminal-tool\)/,
  );
});
