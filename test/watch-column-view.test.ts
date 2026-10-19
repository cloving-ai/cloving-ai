import assert from "node:assert/strict";
import { test } from "node:test";
import { Board, Column } from "../src/cli/watch-board-view.ts";
import { component, type WatchElement } from "../src/cli/watch-element.ts";
import { activeBoardModel } from "./watch-board-fixture.ts";
import { found, rendered } from "./watch-dom.ts";
import { played } from "./watch-browser.ts";

function isAction(value: unknown): value is () => void {
  return typeof value === "function";
}

await test("CLV-134 a column sends its own name for toggle, hover and focus and tolerates absent controls", () => {
  const model = activeBoardModel();
  const workflow = model.workflows[0];
  const column = workflow?.columns[0];
  assert.ok(workflow && column);
  const toggled: string[] = [];
  const hovered: (string | null)[] = [];
  const focused: (string | null)[] = [];
  const controls = {
    choices: { [column.name]: false },
    onToggle: (name: string) => toggled.push(name),
    onHover: (name: string | null) => hovered.push(name),
    onFocus: (name: string | null) => focused.push(name),
  };
  for (const callbacks of [
    controls,
    { choices: null, onToggle: controls.onToggle },
    undefined,
  ]) {
    const shown: WatchElement = component(Column, {
      column,
      workflowId: workflow.workflowId,
      now: model.updatedAt,
      controls: callbacks,
    });
    const section: Readonly<Record<string, unknown>> | undefined = found(
      shown,
      "section",
    )[0];
    assert.ok(section);
    const button: Readonly<Record<string, unknown>> | undefined = found(
      shown,
      "button",
    )[0];
    const actions: readonly unknown[] = [
      button?.["onClick"],
      section["onMouseEnter"],
      section["onMouseLeave"],
      section["onFocusIn"],
      section["onFocusOut"],
    ];
    for (const action of actions) {
      assert.ok(isAction(action));
      action();
    }
  }
  assert.deepEqual(toggled, [column.name, column.name]);
  assert.deepEqual(hovered, [column.name, null]);
  assert.deepEqual(focused, [column.name, null]);
  assert.deepEqual(controls.choices, { [column.name]: false });
});

await test("CLV-134 every column has its name, card count and accessible collapse control", () => {
  const model = activeBoardModel();
  const workflow = model.workflows[0];
  assert.ok(workflow);
  const shown = component(Board, { workflow, now: model.updatedAt });
  const columns = found(shown, "section");
  assert.equal(columns.length, workflow.columns.length);
  for (const [index, column] of workflow.columns.entries()) {
    const header = found(columns[index]?.["children"], "h3")[0];
    assert.ok(header);
    assert.match(rendered(header["children"]), new RegExp(column.name));
    const count = found(header["children"], "span").find(
      (item) => item["class"] === "column-count",
    );
    assert.equal(count?.["children"], String(column.cards.length));
    const button = found(header["children"], "button")[0];
    const collapsed = ["Done", "Stopped"].includes(column.name);
    assert.equal(
      button?.["aria-label"],
      `${collapsed ? "Expand" : "Collapse"} ${column.name}`,
    );
    assert.equal(button["aria-expanded"], String(!collapsed));
  }
});

await test("CLV-134 terminal columns default to strips with counts and no cards", () => {
  const model = activeBoardModel();
  const workflow = model.workflows[0];
  assert.ok(workflow);
  const card = workflow.columns.flatMap((column) => column.cards)[0];
  assert.ok(card);
  const shown = component(Board, {
    workflow: {
      ...workflow,
      columns: ["Done", "Stopped"].map((name) => ({ name, cards: [card] })),
    },
    now: model.updatedAt,
  });
  for (const column of found(shown, "section")) {
    assert.match(String(column["class"]), /collapsed/);
    assert.equal(found(column["children"], "article").length, 0);
    assert.match(rendered(column["children"]), /class="column-count">1/);
  }
});

await test("CLV-134 collapse buttons persist choices per workflow across reloads and keep watch reads only", () => {
  const result = played(
    activeBoardModel(),
    `
const saved = new Map();
globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
const model = JSON.parse(process.env.WATCH_MODEL);
location.hash = "#workflow=develop-issue";
replies.push(model);
await load();
const control = (name) => app.all("button").find((node) => node.attributes.get("aria-label") === name);
const initial = app.inner;
control("Expand Done")?.dispatch("click");
control("Collapse Work tree")?.dispatch("click");
const changed = app.inner;
location.hash = "#workflow=develop-ticket";
draw();
const other = app.inner;
state.columns = {};
location.hash = "#workflow=develop-issue";
draw();
console.log(JSON.stringify({ initial, changed, other, reloaded: app.inner, saved: [...saved], requests }));
`,
  );
  assert.match(String(result["initial"]), /aria-label="Expand Done"/);
  assert.match(String(result["changed"]), /aria-label="Collapse Done"/);
  assert.match(String(result["changed"]), /aria-label="Expand Work tree"/);
  assert.match(String(result["other"]), /aria-label="Expand Done"/);
  assert.equal(result["reloaded"], result["changed"]);
  assert.deepEqual(result["requests"], ["data.json"]);
  assert.ok(Array.isArray(result["saved"]) && result["saved"].length === 1);
});

await test("CLV-134 backslash toggles the hovered or focused column without claiming other keystrokes", () => {
  const result = played(
    activeBoardModel(),
    `
location.hash = "#workflow=develop-issue";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
const column = () => app.all("section").find((node) => node.text.startsWith("Done "));
let prevented = 0;
const key = (changes = {}) => listeners.keydown?.({ key: String.fromCharCode(92), preventDefault() { prevented++; }, ...changes });
const label = () => column().all("button")[0].attributes.get("aria-label");
column().dispatch("mouseenter");
key();
const opened = label();
for (const changes of [{ key: "x" }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { repeat: true }, { defaultPrevented: true }, { isComposing: true }, { target: { closest: () => ({}) } }]) key(changes);
const ignored = label();
column().dispatch("mouseleave");
key();
const unhovered = label();
column().dispatch("focusin");
key();
const focused = label();
column().dispatch("mouseenter");
column().dispatch("mouseleave");
key();
const retainedFocus = label();
column().dispatch("focusout");
key();
console.log(JSON.stringify({ opened, ignored, unhovered, focused, retainedFocus, blurred: label(), prevented, requests }));
`,
  );
  assert.equal(result["opened"], "Collapse Done");
  assert.equal(result["ignored"], "Collapse Done");
  assert.equal(result["unhovered"], "Collapse Done");
  assert.equal(result["focused"], "Expand Done");
  assert.equal(result["retainedFocus"], "Collapse Done");
  assert.equal(result["blurred"], "Collapse Done");
  assert.equal(result["prevented"], 3);
  assert.deepEqual(result["requests"], ["data.json"]);
});

for (const store of ["missing", "denied", "broken", "invalid"]) {
  await test(`CLV-134 ${store} storage uses default collapse state and buttons still work`, () => {
    const result = played(
      activeBoardModel(),
      `
const mode = ${JSON.stringify(store)};
if (mode === "denied") Object.defineProperty(globalThis, "localStorage", { get() { throw new Error("denied"); } });
if (mode === "broken" || mode === "invalid") globalThis.localStorage = { getItem: () => mode === "broken" ? "{" : '{"Done":"false","Work tree":null}', setItem() { throw new Error("full"); } };
location.hash = "#workflow=develop-issue";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
const initial = app.inner;
app.all("button").find((node) => node.attributes.get("aria-label") === "Expand Done")?.dispatch("click");
draw();
console.log(JSON.stringify({ initial, changed: app.inner }));
`,
    );
    assert.match(String(result["initial"]), /aria-label="Expand Done"/);
    assert.match(String(result["initial"]), /aria-label="Collapse Work tree"/);
    assert.match(String(result["changed"]), /aria-label="Collapse Done"/);
  });
}
