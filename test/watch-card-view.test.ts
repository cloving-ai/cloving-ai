import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AddCard,
  cardKey,
  CardInput,
  type CardControls,
  type CardDraft,
} from "../src/cli/watch-card-view.ts";
import { cardReply } from "../src/cli/watch-card-reply.ts";
import { builtinCardForms } from "../src/cli/watch-run-input.ts";
import { found, rendered } from "./watch-dom.ts";

const form = builtinCardForms()[0];
assert.ok(form);
const draft: CardDraft = {
  commandId: "card-1",
  fields: {},
  pending: false,
  admitted: false,
  message: "",
};

function listener(value: unknown): value is (event: unknown) => void {
  return typeof value === "function";
}

function handler(
  props: Readonly<Record<string, unknown>> | undefined,
  name: string,
): (event: unknown) => void {
  const callback = props?.[name];
  assert.ok(listener(callback));
  return callback;
}

await test("CLV-135 card view callbacks open, edit, submit and close with accessible feedback", () => {
  const calls: unknown[] = [];
  const controls: CardControls = {
    draft: null,
    onOpen: () => {
      calls.push("open");
    },
    onCancel: () => {
      calls.push("cancel");
    },
    onSubmit: () => {
      calls.push("submit");
    },
    onChange: (name, value) => {
      calls.push({ name, value });
    },
  };
  handler(found(AddCard({ form, controls }), "button")[0], "onClick")({});
  const shown = AddCard({ form, controls: { ...controls, draft } });
  handler(
    found(shown, "input")[0],
    "onInput",
  )({
    currentTarget: { value: "192" },
  });
  const event = new Event("submit", { cancelable: true });
  handler(found(shown, "form")[0], "onSubmit")(event);
  assert.equal(event.defaultPrevented, true);
  handler(
    found(shown, "form")[0],
    "onKeyDown",
  )({
    key: "Escape",
    preventDefault: () => {
      calls.push("prevent");
    },
  });
  handler(found(shown, "button")[1], "onClick")({});
  assert.deepEqual(calls, [
    "open",
    { name: "ticket", value: "192" },
    "submit",
    "prevent",
    "cancel",
    "cancel",
  ]);
  assert.match(rendered(shown), /role="status" aria-live="polite"/);
  assert.equal(AddCard({ form: undefined, controls }), null);
  assert.equal(AddCard({ form, controls: undefined }), null);
});

await test("CLV-135 the view reflects pending, admitted and optional multiline fields", () => {
  const controls: CardControls = {
    draft,
    onOpen() {},
    onCancel() {},
    onSubmit() {},
    onChange() {},
  };
  const field = {
    name: "idea",
    label: "Idea",
    multiline: true,
    optional: true,
  };
  const input = found(
    CardInput({
      field,
      controls,
      draft: { ...draft, fields: { idea: "Text" }, pending: true },
    }),
    "textarea",
  )[0];
  assert.equal(input?.["value"], "Text");
  assert.equal(input["required"], false);
  assert.equal(input["disabled"], true);
  const pending = AddCard({
    form,
    controls: { ...controls, draft: { ...draft, pending: true } },
  });
  assert.equal(found(pending, "button")[0]?.["children"], "Adding…");
  const admitted = AddCard({
    form,
    controls: {
      ...controls,
      draft: { ...draft, admitted: true, message: "Run run-1 is admitted" },
    },
  });
  assert.equal(found(admitted, "button")[0]?.["disabled"], true);
  assert.match(rendered(admitted), /Run run-1 is admitted/);
});

await test("CLV-135 keyboard guards preserve composition, repeated keys, ordinary text and button Enter", () => {
  const calls: string[] = [];
  const controls: CardControls = {
    draft,
    onOpen() {},
    onChange() {},
    onCancel: () => {
      calls.push("cancel");
    },
    onSubmit: () => {
      calls.push("submit");
    },
  };
  const event = {
    key: "Enter",
    target: { localName: "input" },
    currentTarget: new (class {
      requestSubmit() {
        calls.push("requestSubmit");
      }
    })(),
    preventDefault: () => {
      calls.push("prevent");
    },
  };
  for (const patch of [
    { defaultPrevented: true },
    { isComposing: true },
    { repeat: true },
    { key: "a" },
    { target: { localName: "button" } },
    { target: {} },
    { target: { localName: "textarea" } },
  ])
    cardKey({ ...event, ...patch }, controls);
  assert.deepEqual(calls, []);
  cardKey(event, controls);
  cardKey(
    { ...event, target: { localName: "textarea" }, metaKey: true },
    controls,
  );
  cardKey(
    { ...event, target: { localName: "textarea" }, ctrlKey: true },
    controls,
  );
  assert.deepEqual(calls, [
    "prevent",
    "requestSubmit",
    "prevent",
    "requestSubmit",
    "prevent",
    "requestSubmit",
  ]);
});

await test("CLV-135 admission and known refusals have operator-facing feedback and unknown codes remain visible", () => {
  assert.deepEqual(cardReply({ kind: "result", result: { runId: "run-1" } }), {
    admitted: true,
    message: "Run run-1 is admitted",
  });
  assert.deepEqual(
    cardReply({
      kind: "error",
      error: { code: "workflow-active", detail: "Busy" },
    }),
    {
      admitted: false,
      message:
        "workflow-active: Add the label cloving: ready to the issue to put it in the queue.",
    },
  );
  assert.deepEqual(
    cardReply({
      kind: "error",
      error: { code: "future-code", detail: "Private detail" },
    }),
    { admitted: false, message: "future-code: The service refused this run." },
  );
  assert.match(
    cardReply({
      kind: "error",
      error: { code: "outcome-unknown", detail: "Lost" },
    }).message,
    /same command ID/,
  );
});
