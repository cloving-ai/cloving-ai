import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { pageDocument } from "../src/cli/watch-page.ts";
import type { PhoneControls } from "../src/cli/watch-phone-view.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { Page } from "../src/cli/watch-view.ts";
import { boardModel } from "./watch-board-fixture.ts";
import { rendered } from "./watch-dom.ts";
import { noCopy } from "./watch-sample.ts";
import { contrast, palette, rgb } from "./watch-style-fixture.ts";

const queue = {
  busy: 0,
  lanes: 3,
  skipped: [
    {
      ticketId: "234",
      reason: "ticket-dependency-open",
      dependencies: ["233"],
    },
    {
      ticketId: "337",
      reason: "ticket-dependency-open",
      dependencies: ["295", "336"],
    },
    { ticketId: "363", reason: "ticket-active" },
    { ticketId: "400", reason: "ticket-not-available" },
  ],
};

const phone: PhoneControls = {
  pairing: null,
  request: null,
  stage: null,
  connected: null,
  refusal: null,
  reason: null,
  devices: [
    {
      deviceId: "device-1",
      name: "iPhone",
      platform: "ios",
      state: "connected",
      removedAt: null,
    },
  ],
  busy: false,
  message: "",
  onPair: () => undefined,
  onCancel: () => undefined,
  onAccept: () => undefined,
  onDeny: () => undefined,
  onRemove: () => undefined,
};

function page(model: WatchModel, selected: string): string {
  return rendered(
    component(Page, {
      model,
      selected,
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
      phone,
    }),
  );
}

function part(
  html: string,
  bounds: { readonly open: string; readonly close: string },
): string {
  const start = html.indexOf(bounds.open);
  assert.ok(start >= 0, bounds.open);
  const end = html.indexOf(bounds.close, start) + bounds.close.length;
  return html.slice(start, end);
}

const css = pageDocument().split("<style>")[1]?.split("</style>")[0] ?? "";
const rules = [...css.matchAll(/\n([^{}\n]+) \{([^}]*)\}/g)].map(
  ([, selectors, body]) => ({
    selectors: (selectors ?? "").trim().split(", "),
    body: body ?? "",
  }),
);

function declarations(selector: string): string {
  const bodies = rules
    .filter((item) => item.selectors.includes(selector))
    .map((item) => item.body);
  assert.ok(bodies.length > 0, selector);
  return bodies.join(";");
}

function hoverToken(selector: string): string {
  const own = rules
    .filter((item) => item.selectors.includes(selector))
    .map((item) => /background: var\(--([a-z0-9-]+)\)/.exec(item.body)?.[1])
    .findLast((token) => token !== undefined);
  const general = rules
    .filter((item) => item.selectors.includes("button:hover"))
    .map((item) => /background: var\(--([a-z0-9-]+)\)/.exec(item.body)?.[1])
    .findLast((token) => token !== undefined);
  const token = own ?? general;
  assert.ok(token !== undefined, selector);
  return token;
}

await test("watch design: the header shows the queue in one line and a closed disclosure lists the skipped tickets in plain words", () => {
  const html = page(
    boardModel([], { queue, workflows: ["develop-issue"] }),
    "workflow=develop-issue",
  );
  const header = part(html, { open: "<header", close: "</header>" });
  assert.match(header, /0 of 3 lanes busy/);
  const waiting = part(html, {
    open: '<details class="queue-waiting"',
    close: "</details>",
  });
  assert.doesNotMatch(waiting, /<details[^>]* open/);
  assert.match(waiting, /<summary>4 tickets skipped<\/summary>/);
  for (const line of [
    "#234 waits for #233",
    "#337 waits for #295, #336",
    "#363 is in work",
    "#400: ticket-not-available",
  ])
    assert.ok(waiting.includes(`<li>${line}</li>`), line);
  assert.doesNotMatch(html, /ticket-dependency-open|ticket-active/);
  assert.doesNotMatch(html, /Skipped ticket/);
  assert.ok(html.indexOf("queue-waiting") < html.indexOf('class="workflows"'));
});

await test("watch design: a queue without skipped tickets shows no disclosure", () => {
  const html = page(
    boardModel([], {
      queue: { busy: 1, lanes: 3, skipped: [] },
      workflows: ["develop-issue"],
    }),
    "workflow=develop-issue",
  );
  assert.match(
    part(html, { open: "<header", close: "</header>" }),
    /1 of 3 lanes busy/,
  );
  assert.doesNotMatch(html, /queue-waiting/);
});

await test("watch design: the run page shows the same queue line and disclosure", () => {
  const html = page(
    boardModel([], { queue, workflows: ["develop-issue"] }),
    "workflow=develop-issue&run=run-missing",
  );
  assert.match(html, /0 of 3 lanes busy/);
  assert.match(html, /<details class="queue-waiting"/);
  assert.doesNotMatch(html, /ticket-dependency-open/);
});

await test("watch design: one header holds the status and phone controls", () => {
  const html = page(
    boardModel([], { queue, workflows: ["develop-issue"] }),
    "workflow=develop-issue",
  );
  const header = part(html, { open: "<header", close: "</header>" });
  for (const text of [
    "cloving",
    "updated",
    "0 of 3 lanes busy",
    "Connect a phone",
    "iPhone (ios) connected",
    "Remove",
  ])
    assert.ok(header.includes(text), text);
  assert.doesNotMatch(header, /Start a run/);
  assert.equal(html.split('<section class="phone').length - 1, 1);
});

await test("watch design: the board heading that repeats the selected tab is only for screen readers", () => {
  const html = page(
    boardModel([], { workflows: ["develop-issue"] }),
    "workflow=develop-issue",
  );
  assert.match(html, /<h2 class="visually-hidden">develop-issue<\/h2>/);
  const hidden = declarations(".visually-hidden");
  for (const declaration of [
    /position: absolute/,
    /width: 1px/,
    /height: 1px/,
    /overflow: hidden/,
    /clip-path: inset\(50%\)/,
    /white-space: nowrap/,
  ])
    assert.match(hidden, declaration);
});

await test("watch design: page controls outside code windows use the body font and a readable light hover in both themes", () => {
  for (const selector of [
    "header button",
    ".phone button",
    ".column-name button",
    ".add-card",
    ".add-card-form button",
  ])
    assert.match(declarations(selector), /font: [^;]*var\(--body-font\)/);
  for (const selector of [
    "header button:hover",
    ".phone button:hover",
    ".column-name button:hover",
    ".add-card:hover",
  ]) {
    const token = hoverToken(selector);
    assert.notEqual(token, "code-head", selector);
    for (const [theme, tokens] of Object.entries(palette)) {
      const background: unknown = Reflect.get(tokens, token);
      assert.ok(typeof background === "string", `${selector} ${token}`);
      assert.ok(
        contrast(rgb(tokens.ink), rgb(background)) >= 4.5,
        `${selector} in the ${theme} theme: ink on ${token}`,
      );
    }
  }
  assert.match(declarations("button"), /var\(--code-font\)/);
});

await test("watch design: column names are labels in the body font", () => {
  assert.match(declarations(".column-name"), /font: [^;]*var\(--body-font\)/);
  assert.doesNotMatch(declarations(".column-name"), /var\(--code-font\)/);
});

await test("watch design: the add-card button has no side margin, so it fits its column", () => {
  const margins = [...declarations(".add-card").matchAll(/margin: ([^;]+)/g)];
  assert.equal(margins.at(-1)?.[1], "4px 0");
});

await test("watch design: a collapsed Stopped column keeps red text but no red frame or tint", () => {
  const collapsed = declarations(".column.stopped.collapsed");
  assert.match(collapsed, /inset 0 0 0 1px var\(--line\)/);
  assert.match(collapsed, /background: var\(--surface-2\)/);
  assert.doesNotMatch(collapsed, /--bad/);
  assert.match(declarations(".stopped .column-name"), /color: var\(--bad\)/);
  assert.match(declarations(".column.stopped"), /var\(--bad-tint\)/);
});

await test("watch design: the pairing view of the phone takes its own row in the header", () => {
  assert.match(declarations(".phone-pairing"), /flex-basis: 100%/);
});

await test("watch design: card details read in the body font, and only the run ID stays in the code font", () => {
  for (const selector of [".card-step", ".card-review", ".card-cost"]) {
    assert.match(declarations(selector), /font: [^;]*var\(--body-font\)/);
    assert.doesNotMatch(declarations(selector), /var\(--code-font\)/);
  }
  assert.match(declarations(".card small"), /var\(--code-font\)/);
});

await test("watch design: cards in a column are flat, so the column edge does not cut a shadow into a band", () => {
  assert.doesNotMatch(declarations(".card"), /var\(--shadow\)/);
  assert.doesNotMatch(declarations(".stopped .card"), /var\(--shadow\)/);
  assert.match(declarations(".card"), /inset 0 0 0 1px var\(--line\)/);
});
