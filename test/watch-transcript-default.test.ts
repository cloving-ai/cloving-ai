import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import type { WatchTurn } from "../src/cli/watch-render.ts";
import {
  type TranscriptControls,
  type TranscriptTarget,
} from "../src/cli/watch-transcript-view.ts";
import { RunTurns } from "../src/cli/watch-run-tabs-view.ts";
import { rendered } from "./watch-dom.ts";
import {
  at,
  sampleRun,
  sampleTurn,
  wantedTranscripts,
} from "./watch-sample.ts";

function turnAt(
  position: number,
  changes: { readonly outcome: string; readonly startedAt?: string },
): WatchTurn {
  return sampleTurn({
    key: `k${String(position)}`,
    operationId: `operation-${String(position)}`,
    startedAt: at(`21:2${String(position)}:00`),
    ...changes,
  });
}

function wanted(options: {
  readonly turns: readonly WatchTurn[];
  readonly turnId?: string;
}): readonly (readonly [string, boolean])[] {
  const asked: TranscriptTarget[] = [];
  const controls: TranscriptControls = {
    ...wantedTranscripts,
    view: (target) => {
      asked.push(target);
      return wantedTranscripts.view(target);
    },
  };
  rendered(
    component(RunTurns, {
      run: sampleRun({ state: "completed", turns: options.turns }),
      now: at("21:40:00"),
      transcripts: controls,
      turnId: options.turnId ?? null,
    }),
  );
  return asked.map((target) => [target.operationId, target.wanted]);
}

const ended = [
  turnAt(1, { outcome: "completed" }),
  turnAt(2, { outcome: "failed" }),
  turnAt(3, { outcome: "completed" }),
];

await test("CLV-332 an ended run with three agent turns asks for the transcript of the last turn open and the first two closed", () => {
  assert.deepEqual(wanted({ turns: ended }), [
    ["operation-1", false],
    ["operation-2", false],
    ["operation-3", true],
  ]);
});

await test("CLV-332 a run with a turn in work asks only for that transcript open", () => {
  assert.deepEqual(
    wanted({
      turns: [
        turnAt(1, { outcome: "completed" }),
        turnAt(2, { outcome: "in work" }),
        turnAt(3, { outcome: "completed" }),
      ],
    }),
    [
      ["operation-1", false],
      ["operation-2", true],
      ["operation-3", false],
    ],
  );
});

await test("CLV-332 a link to the first turn of an ended run asks for the first transcript open and the last closed", () => {
  assert.deepEqual(wanted({ turns: ended, turnId: "operation-1" }), [
    ["operation-1", true],
    ["operation-2", false],
    ["operation-3", false],
  ]);
});

await test("CLV-332 a link to a turn that the run does not have keeps the last turn open", () => {
  assert.deepEqual(wanted({ turns: ended, turnId: "operation-9" }), [
    ["operation-1", false],
    ["operation-2", false],
    ["operation-3", true],
  ]);
});

await test("CLV-332 the last turn is the turn that started last, also when the run lists it before an earlier turn", () => {
  assert.deepEqual(
    wanted({
      turns: [
        turnAt(1, { outcome: "completed", startedAt: at("21:29:00") }),
        turnAt(2, { outcome: "completed" }),
      ],
    }),
    [
      ["operation-1", true],
      ["operation-2", false],
    ],
  );
});
