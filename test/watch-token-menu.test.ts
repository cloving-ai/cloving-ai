import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { component } from "../src/cli/watch-element.ts";
import type { RenameControls } from "../src/cli/watch-rename-view.ts";
import type { RunCommandControls } from "../src/cli/watch-run-command-view.ts";
import {
  type MenuTarget,
  menuEntered,
  menuExited,
  menuLeft,
  menuOpened,
} from "../src/cli/watch-token-menu-view.ts";
import { Page } from "../src/cli/watch-view.ts";
import { found, rendered } from "./watch-dom.ts";
import { rule } from "./watch-style-fixture.ts";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";
import { renameControls, type RenameCalls } from "./watch-rename-fixture.ts";
import { noCopy } from "./watch-sample.ts";

const model = floorModel([
  floorRun("run-a", { operation: "claude-turn", minutes: 5 }),
  floorRun("paused-run", {
    operation: "github-merge",
    minutes: 20,
    state: "paused",
    pausedMinutes: 10,
  }),
]);

const controlling: RunCommandControls = {
  busy: [],
  messages: {},
  asking: null,
  onCommand: () => undefined,
  onAsk: () => undefined,
  onKeep: () => undefined,
};

function calls(): RenameCalls {
  return { opened: [], saved: [], cleared: [], closed: [] };
}

function floor(
  parts: {
    readonly controlling?: RunCommandControls;
    readonly renaming?: RenameControls;
  } = {},
) {
  return component(Page, {
    model,
    selected: "",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
    ...parts,
  });
}

function menus(shown: unknown) {
  return found(shown, "div").filter((item) => item["class"] === "token-menu");
}

function labels(node: unknown): readonly string[] {
  return found(node, "button").map((button) => {
    const label = button["children"];
    assert.ok(typeof label === "string");
    return label;
  });
}

await test("CLV-354 each station token holds its run controls and Rename in a popover menu that opens at the menu button, and the floor has no run menu details", () => {
  const shown = floor({ controlling, renaming: renameControls(calls()) });
  const items = menus(shown);
  assert.equal(items.length, 2);
  const parts = items.map((menu) => {
    const [open] = found(menu["children"], "button").filter(
      (button) => button["class"] === "token-menu-open",
    );
    const [pop] = found(menu["children"], "div").filter(
      (item) => item["class"] === "token-pop",
    );
    return {
      label: open?.["aria-label"],
      action: open?.["popovertargetaction"],
      target: open?.["popovertarget"] === pop?.["id"],
      popover: pop?.["popover"],
      id: /^token-menu-(run-a|paused-run)$/.test(String(pop?.["id"])),
      buttons: labels(pop?.["children"]),
    };
  });
  const common = {
    label: "Run controls",
    action: "show",
    target: true,
    popover: "auto",
    id: true,
  };
  assert.deepEqual(
    parts.toSorted((left, right) =>
      String(left.buttons[0]).localeCompare(String(right.buttons[0])),
    ),
    [
      { ...common, buttons: ["Pause", "Rename", "Drop"] },
      { ...common, buttons: ["Resume", "Rename", "Drop"] },
    ],
  );
  assert.equal(
    found(shown, "details").filter((menu) => menu["class"] === "run-menu")
      .length,
    0,
  );
});

await test("CLV-354 the token menu shows only the parts that the page can send, and no menu without actions", () => {
  const pops = found(
    floor({ renaming: renameControls(calls()) }),
    "div",
  ).filter((item) => item["class"] === "token-pop");
  assert.deepEqual(
    pops.map((pop) => labels(pop["children"])),
    [["Rename"], ["Rename"]],
  );
  assert.doesNotMatch(rendered(floor()), /token-menu|run-command|rename/);
});

await test("CLV-354 the open rename form of a token stays in its popover with Save and Cancel", () => {
  const renaming = renameControls(calls(), {
    open: "run-a",
    title: "Old title",
    label: "#727",
  });
  const [form] = found(floor({ controlling, renaming }), "form");
  assert.ok(form);
  assert.equal(form["class"], "rename-form");
  assert.deepEqual(labels(form["children"]), ["Save", "Cancel"]);
  const pop = found(floor({ controlling, renaming }), "div").find(
    (item) =>
      item["class"] === "token-pop" &&
      found(item["children"], "form").length === 1,
  );
  assert.equal(pop?.["id"], "token-menu-run-a");
});

function menuNode() {
  const shown: string[] = [];
  const pop = {
    open: false,
    matches: (selector: string) => selector === ":popover-open" && pop.open,
    showPopover: () => {
      pop.open = true;
      shown.push("show");
    },
    hidePopover: () => {
      pop.open = false;
      shown.push("hide");
    },
  };
  const focus = { visible: false };
  const opener = {
    matches: () => false,
    showPopover: () => undefined,
    hidePopover: () => undefined,
    focus: () => {
      shown.push("focus");
    },
  };
  const menu = {
    dataset: {} as Record<string, string | undefined>,
    querySelector: (selector: string) => {
      if (selector === ".token-pop") return { ...pop, focus: () => undefined };
      if (selector === ".token-menu-open") return opener;
      return selector === ":focus-visible" && focus.visible ? opener : null;
    },
  };
  return { menu, pop, focus, shown };
}

await test("CLV-354 the token menu opens at once, closes 200 ms after the pointer leaves, stays open when the pointer comes back within that time, and stays open while an input inside has the keyboard focus", async () => {
  const node = menuNode();
  menuOpened(node.menu);
  assert.equal(node.pop.open, true);
  menuLeft(node.menu);
  await delay(80);
  menuOpened(node.menu);
  await delay(260);
  assert.equal(node.pop.open, true);
  menuLeft(node.menu);
  await delay(260);
  assert.equal(node.pop.open, false);
  menuOpened(node.menu);
  node.focus.visible = true;
  menuLeft(node.menu);
  await delay(260);
  assert.equal(node.pop.open, true);
  assert.deepEqual(node.shown, ["show", "hide", "show"]);
});

await test("CLV-354 the README describes the token menu of the floor with Rename, hover, keyboard focus and Escape", async () => {
  const readme = (
    await readFile(new URL("../README.md", import.meta.url), "utf8")
  ).replaceAll("\n", " ");
  assert.match(
    readme,
    /The token of an active run on the floor has these controls and \*\*Rename\*\* in a menu at the right end of the token \(`⋯`\)\. The menu opens when the pointer is on the `⋯`, when the `⋯` has the keyboard focus, or with a click or a tap, and it stays open while the pointer moves into it or while one of its fields has the focus\. Escape, a click outside and the pointer leaving close it\./,
  );
});

function manual(run: Record<string, unknown>): Record<string, unknown> {
  const status = run["status"];
  return {
    ...run,
    status: {
      ...(typeof status === "object" ? status : {}),
      title: "My title",
      titleSource: "manual",
    },
  };
}

await test("CLV-354 the token popover is one list: Pause or Resume, Rename, Use the automatic name when it applies, a separator, and Drop last in the danger part", () => {
  const named = floorModel([
    manual(floorRun("run-a", { operation: "claude-turn", minutes: 5 })),
  ]);
  const shown = component(Page, {
    model: named,
    selected: "",
    now: named.updatedAt,
    stale: false,
    copying: noCopy,
    controlling,
    renaming: renameControls(calls()),
  });
  const [pop] = found(shown, "div").filter(
    (item) => item["class"] === "token-pop",
  );
  assert.deepEqual(labels(pop?.["children"]), [
    "Pause",
    "Rename",
    "Use the automatic name",
    "Drop",
  ]);
  assert.match(
    rendered(shown),
    /id="token-menu-run-a"[^]*?class="run-command-pause"[^]*?class="rename"[^]*?<hr class="token-separator"[^]*?class="token-danger"><button[^>]*class="run-command-drop"/,
  );
  const [danger] = found(pop?.["children"], "div").filter(
    (item) => item["class"] === "token-danger",
  );
  assert.deepEqual(labels(danger?.["children"]), ["Drop"]);
  const asking = {
    ...controlling,
    asking: { runId: "run-a", place: "token" as const },
  };
  const [asked] = found(
    component(Page, {
      model: named,
      selected: "",
      now: named.updatedAt,
      stale: false,
      copying: noCopy,
      controlling: asking,
    }),
    "div",
  ).filter((item) => item["class"] === "token-danger");
  assert.deepEqual(labels(asked?.["children"]), ["Drop the run", "Keep it"]);
});

await test("CLV-354 the token popover lists one item for each row in the card font, marks Drop in the stopped color, and puts Save and Cancel of the rename form side by side", () => {
  assert.match(rule(".token-pop .run-command"), /display: grid/);
  assert.match(rule(".token-pop button"), /width: 100%/);
  assert.match(rule(".token-pop button"), /text-align: left/);
  assert.match(rule(".token-separator"), /border-top: /);
  assert.match(
    rule(".token-danger button"),
    /color: var\(--color-state-failed\)/,
  );
  assert.match(
    rule(".token-pop .rename-form"),
    /grid-template-columns: 1fr 1fr/,
  );
  assert.match(rule(".token-pop .rename-form label"), /grid-column: 1 \/ -1/);
  assert.match(
    rule('.token-pop .rename-form button[type="submit"]'),
    /background: var\(--color-accent\); color: var\(--color-on-accent\)/,
  );
  assert.match(
    rule('.token-pop .rename-form button[type="button"]'),
    /background: none/,
  );
});

interface MenuFields {
  readonly relatedTarget?: MenuTarget | null;
  readonly key?: string;
}

await test("CLV-354 the token menu element opens on pointer enter and focus in, closes after a pointer leave or a focus move out of the menu, and an Escape inside closes it at once with the focus back on its opener", async () => {
  const [menu] = menus(floor({ controlling }));
  assert.ok(menu);
  const node = menuNode();
  const inside = {};
  const event = (fields: MenuFields = {}) => ({
    currentTarget: {
      ...node.menu,
      contains: (item: MenuTarget | null) => item === inside,
    },
    ...fields,
  });
  const handler = (name: string) => {
    const value = menu[name];
    assert.ok(typeof value === "function");
    return (fields?: MenuFields) => {
      Reflect.apply(value, undefined, [event(fields)]);
    };
  };
  handler("onPointerEnter")();
  handler("onPointerLeave")();
  await delay(260);
  handler("onFocusIn")();
  handler("onFocusOut")({ relatedTarget: inside });
  await delay(260);
  const kept = node.pop.open;
  handler("onFocusOut")({ relatedTarget: null });
  await delay(260);
  handler("onPointerEnter")();
  handler("onKeyDown")({ key: "Enter" });
  const afterEnter = node.pop.open;
  handler("onKeyDown")({ key: "Escape" });
  assert.deepEqual(
    [kept, afterEnter, node.pop.open, node.shown],
    [
      true,
      true,
      false,
      ["show", "hide", "show", "hide", "show", "hide", "focus"],
    ],
  );
});

await test("CLV-354 the token menu stays open while the pointer is inside, also when the keyboard focus leaves it, and closes 200 ms after the pointer leaves too", async () => {
  const node = menuNode();
  menuEntered(node.menu);
  node.focus.visible = true;
  node.focus.visible = false;
  menuLeft(node.menu);
  await delay(260);
  const kept = node.pop.open;
  menuExited(node.menu);
  await delay(100);
  const waiting = node.pop.open;
  await delay(160);
  assert.deepEqual([kept, waiting, node.pop.open], [true, true, false]);
});
