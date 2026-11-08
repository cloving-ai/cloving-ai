import assert from "node:assert/strict";
import { test } from "node:test";
import type { Reply, ServiceRequest } from "../src/protocol.ts";
import { component } from "../src/cli/watch-element.ts";
import type { WatchModel } from "../src/cli/watch-render.ts";
import { Page, type ContinueControls } from "../src/cli/watch-view.ts";
import { actionHeaders, pageToken, postCard } from "./watch-action-fixture.ts";
import { played } from "./watch-browser.ts";
import { found, rendered } from "./watch-dom.ts";
import { floorModel, floorRun } from "./watch-floor-fixture.ts";
import { noCopy } from "./watch-sample.ts";
import { withWatchService } from "./watch-service-fixture.ts";

const note = "Merge the branch of the first run first.";
const turn = JSON.stringify([
  "cloving-operation",
  1,
  "run-new",
  "implement",
  "claude-turn",
]);

function failedRun(
  runId: string,
  status: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const run = floorRun(runId, {
    operation: "github-merge",
    minutes: 30,
    state: "failed",
  });
  const shown = run["status"];
  return {
    ...run,
    status: { ...(typeof shown === "object" ? shown : {}), ...status },
  };
}

function page(
  model: WatchModel,
  options: {
    readonly selected?: string;
    readonly continuing?: ContinueControls;
  },
) {
  return component(Page, {
    model,
    selected: options.selected ?? "",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
    ...(options.continuing === undefined
      ? {}
      : { continuing: options.continuing }),
  });
}

function controls(calls: string[], open: string | null): ContinueControls {
  return {
    busy: [],
    messages: {},
    open,
    note,
    onOpen: (runId) => calls.push(`open ${runId}`),
    onClose: () => calls.push("close"),
    onNote: (text) => calls.push(`note ${text}`),
    onContinue: (runId) => calls.push(`continue ${runId}`),
    onDismiss: (runId) => calls.push(`dismiss ${runId}`),
  };
}

function props(node: unknown): Readonly<Record<string, unknown>> {
  return typeof node === "object" && node !== null ? { ...node } : {};
}

function call(value: unknown, event: unknown): void {
  if (typeof value === "function") Reflect.apply(value, undefined, [event]);
}

await test("CLV-326 Continue opens a note form, and the form sends with Continue or Enter and closes with Esc", () => {
  const calls: string[] = [];
  const model = floorModel([failedRun("failed-merge")]);
  const closed = found(
    page(model, { continuing: controls(calls, null) }),
    "button",
  );
  const opener = closed.find((button) => button["children"] === "Continue");
  call(opener?.["onClick"], {});
  assert.deepEqual(
    found(page(model, { continuing: controls([], null) }), "form"),
    [],
  );
  const shown = page(model, { continuing: controls(calls, "failed-merge") });
  const [form] = found(shown, "form");
  const [input] = found(shown, "input");
  assert.equal(props(input)["value"], note);
  assert.equal(props(input)["type"], "text");
  call(props(input)["onInput"], {
    currentTarget: { value: "Keep the tests." },
  });
  call(props(form)["onSubmit"], {
    preventDefault: () => calls.push("prevented"),
  });
  const submitted: string[] = [];
  class Form {
    requestSubmit(): void {
      submitted.push("submit");
    }
  }
  const target = new Form();
  const key = (name: string) => ({
    key: name,
    target: { localName: "input" },
    currentTarget: target,
    preventDefault: () => undefined,
  });
  call(props(form)["onKeyDown"], key("Enter"));
  call(props(form)["onKeyDown"], key("Escape"));
  assert.deepEqual(calls, [
    "open failed-merge",
    "note Keep the tests.",
    "prevented",
    "continue failed-merge",
    "close",
  ]);
  assert.deepEqual(submitted, ["submit"]);
  assert.deepEqual(
    found(shown, "button").map((button) => [
      button["type"],
      button["children"],
    ]),
    [
      ["submit", "Continue"],
      ["button", "Cancel"],
      ["button", "Dismiss"],
    ],
  );
});

await test("CLV-326 the run detail shows each note with its time and the turn that got it, waiting, or a deleted receipt", () => {
  const model = floorModel([
    failedRun("run-new", {
      notes: [
        {
          noteId: "note-a",
          text: note,
          source: "continue",
          recordedAt: "2026-11-08T10:00:00.000Z",
          receivedBy: turn,
        },
        {
          noteId: "note-b",
          text: "Keep <the> tests.",
          source: "continue",
          recordedAt: "2026-11-08T10:05:00.000Z",
          receivedBy: null,
        },
        {
          noteId: "note-c",
          text: "Use the old branch.",
          source: "continue",
          recordedAt: "2026-11-08T10:06:00.000Z",
          receivedBy: "turn-raw",
        },
        {
          noteId: "note-d",
          text: "Keep the old tests.",
          source: "continue",
          recordedAt: "2026-11-08T10:07:00.000Z",
          receivedBy: null,
          receipt: "deleted",
        },
      ],
    }),
  ]);
  const html = rendered(page(model, { selected: "run=run-new" }));
  assert.match(
    html,
    /<section class="run-notes" aria-label="Notes from the operator"><h3>Notes from the operator<\/h3><ul><li><p class="note-text">Merge the branch of the first run first\.<\/p><p class="meta">2026-11-08T10:00:00\.000Z · got by implement\/claude-turn\/1<\/p><\/li><li><p class="note-text">Keep &lt;the&gt; tests\.<\/p><p class="meta">2026-11-08T10:05:00\.000Z · waiting<\/p><\/li><li><p class="note-text">Use the old branch\.<\/p><p class="meta">2026-11-08T10:06:00\.000Z · got by turn-raw<\/p><\/li><li><p class="note-text">Keep the old tests\.<\/p><p class="meta">2026-11-08T10:07:00\.000Z · receipt deleted by the retention rule<\/p><\/li><\/ul><\/section>/,
  );
  assert.equal(
    rendered(
      page(floorModel([failedRun("run-new")]), { selected: "run=run-new" }),
    ).includes("run-notes"),
    false,
  );
});

function answered(requests: ServiceRequest[]) {
  return (request: ServiceRequest): Reply => {
    if (request.operation !== "continue-run")
      return { kind: "result", result: { runs: [], workflows: [] } };
    requests.push(request);
    return {
      kind: "result",
      result: { kind: "run-continued", runId: "run-new" },
    };
  };
}

await test("CLV-326 the continue action of the page sends the note to continue-run like the CLI and refuses a note that is not text", () => {
  const requests: ServiceRequest[] = [];
  return withWatchService(answered(requests), async (watch) => {
    const headers = actionHeaders(watch, await pageToken(watch));
    const sent = (body: string) =>
      postCard(watch, { path: "actions/continue", headers, body });
    assert.equal((await sent('{"runId":"failed-merge","note":7}')).status, 403);
    assert.equal(
      (await sent(JSON.stringify({ runId: "failed-merge", note }))).status,
      200,
    );
    assert.equal(
      (
        await postCard(watch, {
          path: "actions/dismiss",
          headers,
          body: JSON.stringify({ runId: "failed-merge", note }),
        })
      ).status,
      403,
    );
    assert.deepEqual(
      requests.map(({ parameters }) => [
        parameters["runId"],
        parameters["bundle"],
        parameters["note"],
      ]),
      [["failed-merge", undefined, note]],
    );
  });
});

await test("CLV-326 the page script opens the form, posts the typed note, and posts no note for an empty field", () => {
  const model = {
    ...floorModel([failedRun("failed-merge")]),
    cardForms: [],
  };
  const result = played(
    model,
    `
const model = JSON.parse(process.env.WATCH_MODEL);
const posts = [];
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method === "POST") posts.push(options.body);
  return plain(address, options);
};
location.hash = "";
replies.push(model);
await load();
const button = (text) => app.all("button").find((node) => node.inner === text);
const send = async (text) => {
  button("Continue").dispatch("click");
  await settled();
  const forms = app.all("form").length;
  const input = app.all("input")[0];
  input.value = text;
  input.dispatch("input");
  replies.push({ kind: "run-continued", runId: "run-new" }, model);
  app.all("form")[0].dispatch("submit", { preventDefault: () => undefined });
  for (let turn = 0; turn < 5; turn++) await settled();
  return forms;
};
const forms = [await send("${note}"), await send("   ")];
button("Continue").dispatch("click");
await settled();
app.all("form")[0].dispatch("keydown", { key: "Escape", preventDefault: () => undefined });
await settled();
console.log(JSON.stringify({ posts, forms, closed: app.all("form").length }));
`,
  );
  assert.deepEqual(result["posts"], [
    JSON.stringify({ runId: "failed-merge", note }),
    JSON.stringify({ runId: "failed-merge" }),
  ]);
  assert.deepEqual(result["forms"], [1, 1]);
  assert.equal(result["closed"], 0);
});
