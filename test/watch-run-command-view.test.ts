import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { Page } from "../src/cli/watch-view.ts";
import type { RunCommandControls } from "../src/cli/watch-run-command-view.ts";
import { found, rendered } from "./watch-dom.ts";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";

function revised(
  run: Record<string, unknown>,
  revision: number,
): Record<string, unknown> {
  const status = run["status"];
  return {
    ...run,
    status: { ...(typeof status === "object" ? status : {}), revision },
  };
}

const model = floorModel([
  revised(floorRun("run-a", { operation: "claude-turn", minutes: 5 }), 4),
  revised(
    floorRun("paused-run", {
      operation: "github-merge",
      minutes: 20,
      state: "paused",
      pausedMinutes: 10,
    }),
    7,
  ),
  floorRun("failed-run", {
    operation: "github-merge",
    minutes: 30,
    state: "failed",
  }),
]);

function controls(
  calls: string[],
  changes: Partial<RunCommandControls> = {},
): RunCommandControls {
  return {
    busy: [],
    messages: {},
    asking: null,
    onCommand: (runId, command) => calls.push(`${command} ${runId}`),
    onAsk: (runId) => calls.push(`ask ${runId}`),
    onKeep: () => calls.push("keep"),
    ...changes,
  };
}

function page(selected: string, controlling?: RunCommandControls) {
  return component(Page, {
    model,
    selected,
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
    ...(controlling === undefined ? {} : { controlling }),
  });
}

function inside(props: Readonly<Record<string, unknown>>): readonly unknown[] {
  return found(props["children"], "button").map((button) => button["children"]);
}

function labels(node: unknown, place: string): readonly unknown[] {
  return found(node, "div")
    .filter((item) => item["class"] === place)
    .flatMap(inside);
}

function click(node: unknown, label: string): void {
  const button = found(node, "button").find(
    (item) => item["children"] === label,
  );
  const handler = button?.["onClick"];
  assert.ok(typeof handler === "function", label);
  Reflect.apply(handler, undefined, []);
}

await test("CLV-335 a watch run has the revision of its status, and the card of a paused run says that it is paused", () => {
  assert.deepEqual(
    Object.fromEntries(model.runs.map((run) => [run.runId, run.revision])),
    { "run-a": 4, "paused-run": 7, "failed-run": undefined },
  );
  const cards = model.workflows.flatMap((workflow) =>
    workflow.columns.flatMap((column) => column.cards),
  );
  assert.deepEqual(
    cards.map((card) => [card.runId, card.paused]),
    cards.map((card) => [
      card.runId,
      card.runId === "paused-run" ? true : undefined,
    ]),
  );
  assert.ok(
    cards.every((card) => card.runId === "paused-run" || !("paused" in card)),
  );
});

await test("CLV-335 the run detail of an active run has Pause or Resume and Drop with watch actions on, and an ended run or a page with no actions has no control", () => {
  const calls: string[] = [];
  const controlling = controls(calls);
  assert.deepEqual(labels(page("run=run-a", controlling), "run-command"), [
    "Pause",
    "Drop",
  ]);
  assert.deepEqual(labels(page("run=paused-run", controlling), "run-command"), [
    "Resume",
    "Drop",
  ]);
  assert.deepEqual(
    labels(page("run=failed-run", controlling), "run-command"),
    [],
  );
  assert.deepEqual(labels(page("run=run-a", undefined), "run-command"), []);
  assert.doesNotMatch(rendered(page("run=run-a", undefined)), /run-command/);
  click(page("run=run-a", controlling), "Pause");
  click(page("run=paused-run", controlling), "Resume");
  click(page("run=run-a", controlling), "Drop");
  assert.deepEqual(calls, ["pause run-a", "resume paused-run", "ask run-a"]);
  const busy = found(
    page("run=run-a", controls(calls, { busy: ["run-a"] })),
    "button",
  ).filter((button) => ["Pause", "Drop"].includes(String(button["children"])));
  assert.deepEqual(
    busy.map((button) => button["disabled"]),
    [true, true],
  );
  for (const button of found(page("run=run-a", controlling), "button"))
    assert.equal(button["type"], "button");
});

await test("CLV-335 Drop asks a second click in one line with Drop the run and Keep it, and the control shows the reply of the service", () => {
  const calls: string[] = [];
  const asking = controls(calls, {
    asking: "run-a",
    messages: { "run-a": "Paused" },
  });
  const shown = page("run=run-a", asking);
  assert.match(
    rendered(shown),
    /<p class="drop-question"><span>Drop this run\? Its work tree and pull request stay\.<\/span>/,
  );
  assert.deepEqual(labels(shown, "run-command"), ["Drop the run", "Keep it"]);
  click(shown, "Keep it");
  assert.deepEqual(calls, ["keep"]);
  click(shown, "Drop the run");
  assert.deepEqual(calls, ["keep", "drop run-a"]);
  assert.match(
    rendered(shown),
    /<p class="run-command-message" role="status">Paused<\/p>/,
  );
  assert.doesNotMatch(
    rendered(page("run=paused-run", asking)),
    /drop-question/,
  );
});

await test("CLV-335 each card of an active run and each station token has the controls in a small menu, and a paused run in Needs you has Resume and Drop", () => {
  const calls: string[] = [];
  const controlling = controls(calls);
  const board = page("workflow=develop-issue", controlling);
  const menus = found(board, "details").filter(
    (menu) => menu["class"] === "run-menu",
  );
  assert.deepEqual(
    menus.map((menu) => [
      found(menu["children"], "summary")[0]?.["title"],
      ...inside(menu),
    ]),
    [
      ["Run controls", "Pause", "Drop"],
      ["Run controls", "Resume", "Drop"],
    ],
  );
  assert.equal(
    found(page("workflow=develop-issue", undefined), "details").length,
    0,
  );
  const floor = page("", controlling);
  const tokens = found(floor, "details").filter(
    (menu) => menu["class"] === "run-menu",
  );
  assert.deepEqual(tokens.map(inside).toSorted(), [
    ["Pause", "Drop"],
    ["Resume", "Drop"],
  ]);
  const needs = found(floor, "li").filter((item) =>
    String(item["class"]).startsWith("need "),
  );
  assert.deepEqual(
    needs.map((need) => labels(need["children"], "run-command")),
    [["Resume", "Drop"], []],
  );
  assert.doesNotMatch(rendered(page("", undefined)), /run-command|run-menu/);
});
