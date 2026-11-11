import assert from "node:assert/strict";
import { test } from "node:test";
import type { Reply, ServiceRequest } from "../src/protocol.ts";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { Page } from "../src/cli/watch-view.ts";
import type { SteerControls } from "../src/cli/watch-steer-view.ts";
import { actionHeaders, pageToken, postCard } from "./watch-action-fixture.ts";
import { played } from "./watch-browser.ts";
import { found, rendered } from "./watch-dom.ts";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";
import { withWatchService } from "./watch-service-fixture.ts";

const note = "Change only src/cli.ts.";
const turn = JSON.stringify([
  "cloving-operation",
  1,
  "run-a",
  "implement",
  "claude-turn",
]);

function runningRun(notes: readonly unknown[]): Record<string, unknown> {
  const run = floorRun("run-a", {
    operation: "claude-turn",
    minutes: 5,
    workflowId: "develop-issue",
  });
  const shown = run["status"];
  return {
    ...run,
    status: { ...(typeof shown === "object" ? shown : {}), notes },
  };
}

const waiting = {
  noteId: "note-a",
  text: note,
  source: "steer",
  recordedAt: "2026-11-08T10:00:00.000Z",
  receivedBy: null,
};

function page(
  model: WatchModel,
  options: { readonly selected: string; readonly steering?: SteerControls },
) {
  return component(Page, {
    model,
    selected: options.selected,
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
    ...(options.steering === undefined ? {} : { steering: options.steering }),
  });
}

function controls(calls: string[], open: string | null): SteerControls {
  return {
    busy: [],
    messages: { "run-a": "The note waits for the next turn (queued)." },
    open,
    note,
    now: true,
    onOpen: (runId) => calls.push(`open ${runId}`),
    onClose: () => calls.push("close"),
    onNote: (text) => calls.push(`note ${text}`),
    onNow: (choice) => calls.push(`now ${String(choice.now)}`),
    onSend: (runId) => calls.push(`send ${runId}`),
  };
}

function props(node: unknown): Readonly<Record<string, unknown>> {
  return typeof node === "object" && node !== null ? { ...node } : {};
}

function call(value: unknown, event: unknown): void {
  if (typeof value === "function") Reflect.apply(value, undefined, [event]);
}

function buttons(node: unknown): readonly unknown[] {
  return found(node, "button").map((button) => button["children"]);
}

await test("CLV-327 the running card and the run detail show Steer with watch actions on, and the card shows 1 note waiting until a turn gets the note", () => {
  const board = { selected: "workflow=develop-issue" };
  const detail = { selected: "run=run-a" };
  const steering = controls([], null);
  const noted = floorModel([
    runningRun([
      waiting,
      {
        ...waiting,
        noteId: "note-b",
        text: "Keep the tests.",
        receivedBy: turn,
      },
    ]),
  ]);
  const html = rendered(page(noted, { ...board, steering }));
  assert.match(html, /<span class="note-mark">1 note waiting<\/span>/);
  assert.ok(buttons(page(noted, { ...board, steering })).includes("Steer"));
  assert.ok(buttons(page(noted, { ...detail, steering })).includes("Steer"));
  assert.ok(!buttons(page(noted, board)).includes("Steer"));
  assert.ok(!buttons(page(noted, detail)).includes("Steer"));
  assert.match(
    rendered(page(noted, detail)),
    /<p class="meta">2026-11-08T10:00:00\.000Z · steer · waiting<\/p>/,
  );
  assert.match(
    html,
    /<p class="steer-message" role="status">The note waits for the next turn \(queued\)\.<\/p>/,
  );
  const delivered = floorModel([
    runningRun([{ ...waiting, receivedBy: turn }]),
  ]);
  assert.doesNotMatch(
    rendered(page(delivered, { ...board, steering })),
    /note-mark/,
  );
  const two = floorModel([
    runningRun([waiting, { ...waiting, noteId: "note-b" }]),
  ]);
  assert.match(
    rendered(page(two, board)),
    /<span class="note-mark">2 notes waiting<\/span>/,
  );
});

await test("CLV-327 the Steer form has a note field and the check box Send to the turn in work now, sends with Send, and closes with Esc", () => {
  const calls: string[] = [];
  const model = floorModel([runningRun([])]);
  const closed = found(
    page(model, { selected: "run=run-a", steering: controls(calls, null) }),
    "button",
  );
  call(
    closed.find((button) => button["children"] === "Steer")?.["onClick"],
    {},
  );
  const shown = page(model, {
    selected: "run=run-a",
    steering: controls(calls, "run-a"),
  });
  const [form] = found(shown, "form");
  const [field] = found(shown, "textarea");
  const [box] = found(shown, "input");
  assert.equal(props(field)["value"], note);
  assert.equal(props(box)["type"], "checkbox");
  assert.equal(props(box)["checked"], true);
  assert.match(rendered(shown), /Send to the turn in work now/);
  call(props(field)["onInput"], {
    currentTarget: { value: "Keep the tests." },
  });
  call(props(box)["onChange"], { currentTarget: { checked: false } });
  call(props(form)["onSubmit"], {
    preventDefault: () => calls.push("prevented"),
  });
  call(props(form)["onKeyDown"], {
    key: "Escape",
    target: { localName: "textarea" },
    preventDefault: () => undefined,
  });
  assert.deepEqual(calls, [
    "open run-a",
    "note Keep the tests.",
    "now false",
    "prevented",
    "send run-a",
    "close",
  ]);
  assert.deepEqual(buttons(props(form)["children"]), ["Send", "Cancel"]);
  const busy = page(model, {
    selected: "run=run-a",
    steering: { ...controls([], "run-a"), busy: ["run-a"] },
  });
  const [busyForm] = found(busy, "form");
  assert.deepEqual(
    found(props(busyForm)["children"], "button").map((button) => [
      button["children"],
      button["disabled"],
    ]),
    [
      ["Send", true],
      ["Cancel", undefined],
    ],
  );
});

function answered(requests: ServiceRequest[]) {
  return (request: ServiceRequest): Reply => {
    if (request.operation !== "steer-run")
      return { kind: "result", result: { runs: [], workflows: [] } };
    requests.push(request);
    return {
      kind: "result",
      result: { kind: "run-noted", runId: "run-a", delivery: "now" },
    };
  };
}

await test("CLV-327 the steer action of the page sends the note and now to steer-run like the CLI, and refuses a note that is not text", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(answered(requests), async (watch) => {
    const headers = actionHeaders(watch, await pageToken(watch));
    const sent = (body: unknown) =>
      postCard(watch, {
        path: "actions/steer",
        headers,
        body: JSON.stringify(body),
      });
    assert.equal((await sent({ runId: "run-a", note: 7 })).status, 403);
    assert.equal(
      (await sent({ runId: "run-a", note, now: "yes" })).status,
      403,
    );
    assert.equal((await sent({ runId: "run-a", note, now: true })).status, 200);
    assert.equal((await sent({ runId: "run-a", note })).status, 200);
    assert.deepEqual(
      requests.map(({ parameters }) => [
        parameters["runId"],
        parameters["note"],
        parameters["now"],
        typeof parameters["commandId"],
      ]),
      [
        ["run-a", note, true, "string"],
        ["run-a", note, false, "string"],
      ],
    );
  });
});

await test("CLV-327 the page script opens the Steer form, posts the note with the check box value, and shows the reply", () => {
  const model = { ...floorModel([runningRun([])]), cardForms: [] };
  const result = played(
    model,
    `
const model = JSON.parse(process.env.WATCH_MODEL);
const posts = [];
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method === "POST") posts.push([address, options.body]);
  return plain(address, options);
};
location.hash = "#run=run-a";
replies.push(model);
await load();
const button = (text) => app.all("button").find((node) => node.inner === text);
button("Steer").dispatch("click");
await settled();
const field = app.all("textarea")[0];
field.value = "${note}";
field.dispatch("input");
const box = app.all("input")[0];
box.checked = true;
box.dispatch("change");
replies.push({ kind: "run-noted", runId: "run-a", delivery: "queued", reason: "no-session" }, model);
app.all("form")[0].dispatch("submit", { preventDefault: () => undefined });
for (let turn = 0; turn < 5; turn++) await settled();
const message = app.all("p").find((node) => node.getAttribute("class") === "steer-message")?.inner ?? null;
button("Steer").dispatch("click");
await settled();
app.all("form")[0].dispatch("keydown", { key: "Escape", preventDefault: () => undefined });
await settled();
console.log(JSON.stringify({ posts, message, closed: app.all("form").length }));
`,
  );
  assert.deepEqual(result["posts"], [
    ["actions/steer", JSON.stringify({ runId: "run-a", note, now: true })],
  ]);
  assert.equal(
    result["message"],
    "The note waits for the next turn (queued: no-session).",
  );
  assert.equal(result["closed"], 0);
});

await test("CLV-357 new run data that ends the run closes an open Steer form, and the form stays closed when the run shows again", () => {
  const running = { ...floorModel([runningRun([])]), cardForms: [] };
  const ended = {
    ...running,
    runs: running.runs.map((run) => ({ ...run, state: "completed" })),
  };
  const served = { ...running, ended };
  const result = played(
    served,
    `
const { ended, ...running } = JSON.parse(process.env.WATCH_MODEL);
location.hash = "#run=run-a";
replies.push(running);
await load();
const button = (text) => app.all("button").find((node) => node.inner === text);
button("Steer").dispatch("click");
await settled();
const opened = app.all("textarea").length;
replies.push(ended);
await load();
await settled();
const afterEnd = app.all("textarea").length;
replies.push(running);
await load();
await settled();
console.log(JSON.stringify({ opened, afterEnd, afterReturn: app.all("textarea").length }));
`,
  );
  assert.deepEqual(result, { opened: 1, afterEnd: 0, afterReturn: 0 });
});
