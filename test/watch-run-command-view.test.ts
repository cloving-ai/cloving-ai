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
    onAsk: (runId, place) => calls.push(`ask ${runId} ${place}`),
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
  assert.deepEqual(calls, [
    "pause run-a",
    "resume paused-run",
    "ask run-a detail",
  ]);
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
    asking: { runId: "run-a", place: "detail" },
    messages: { "run-a": { command: "pause", text: "Paused" } },
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

function copies(node: unknown): readonly unknown[][] {
  return found(node, "div")
    .filter((item) => item["class"] === "run-command")
    .map((item) => [item["data-run"], item["data-place"], ...inside(item)]);
}

await test("CLV-335 each copy of the controls names its place, and only the copy that the person pressed asks the second click of Drop", () => {
  const calls: string[] = [];
  const floor = page("", controls(calls));
  assert.deepEqual(copies(floor).toSorted(), [
    ["paused-run", "need", "Resume", "Drop"],
    ["paused-run", "token", "Resume", "Drop"],
    ["run-a", "token", "Pause", "Drop"],
  ]);
  const need = found(floor, "div").find(
    (item) => item["data-place"] === "need",
  );
  click(need?.["children"], "Drop");
  click(page("workflow=develop-issue", controls(calls)), "Drop");
  assert.deepEqual(calls, ["ask paused-run need", "ask run-a card"]);
  const asking = controls(calls, {
    asking: { runId: "paused-run", place: "need" },
  });
  assert.deepEqual(copies(page("", asking)).toSorted(), [
    ["paused-run", "need", "Drop the run", "Keep it"],
    ["paused-run", "token", "Resume", "Drop"],
    ["run-a", "token", "Pause", "Drop"],
  ]);
});

await test("CLV-335 the reply of Drop stays in view after the run ends: the run detail shows it with no control, the board and the floor show it in one line, and an older reply of Pause or Resume does not show for an ended run", () => {
  const dropped = floorModel([
    floorRun("dropped-run", {
      operation: "claude-turn",
      minutes: 5,
      state: "cancelled",
    }),
  ]);
  const controlling = controls([], {
    messages: {
      "dropped-run": { command: "drop", text: "Dropped" },
      "failed-run": { command: "resume", text: "Resumed" },
    },
  });
  const shown = (selected: string, shownModel = dropped) =>
    rendered(
      component(Page, {
        model: shownModel,
        selected,
        now: shownModel.updatedAt,
        stale: false,
        copying: noCopy,
        controlling,
      }),
    );
  const reply = (text: string) =>
    `<p class="run-command-message" role="status">${text}</p>`;
  const lines = (html: string) =>
    html.match(/<p class="run-command-message" role="status">[^<]*<\/p>/g);
  assert.deepEqual(lines(shown("run=dropped-run")), [reply("Dropped")]);
  assert.doesNotMatch(shown("run=dropped-run"), /class="run-command"/);
  for (const selected of ["workflow=develop-issue", ""])
    assert.deepEqual(
      lines(shown(selected)),
      [reply("Title of dropped-run: Dropped")],
      selected,
    );
  for (const selected of ["run=failed-run", "workflow=develop-issue", ""])
    assert.doesNotMatch(shown(selected, model), /run-command-message/);
});
