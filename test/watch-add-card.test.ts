import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinCardForms } from "../src/cli/watch-run-input.ts";
import { boardModel } from "./watch-board-fixture.ts";
import { played } from "./watch-browser.ts";

for (const form of builtinCardForms()) {
  await test(`CLV-135 ${form.workflowId} opens its labeled input on an empty board and cancels without submitting`, () => {
    const result = played(
      {
        ...boardModel([], { workflows: [form.workflowId] }),
        cardForms: [form],
      },
      `
location.hash = "#workflow=${form.workflowId}";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
const button = app.all("button").find((node) => node.text === "+ Add a card");
const initial = { button: button?.text, forms: app.all("form").length };
button?.dispatch("click");
const opened = { forms: app.all("form").length, label: app.all("label").map((node) => node.text), inputs: app.all("input").length, areas: app.all("textarea").length };
app.all("button").find((node) => node.text === "Cancel")?.dispatch("click");
console.log(JSON.stringify({ initial, opened, closed: app.all("form").length, requests }));
`,
    );
    assert.deepEqual(result["initial"], { button: "+ Add a card", forms: 0 });
    assert.deepEqual(result["opened"], {
      forms: 1,
      label: [form.fields[0]?.label],
      inputs: form.source === "ticket" ? 1 : 0,
      areas: form.source === "prompt" ? 1 : 0,
    });
    assert.equal(result["closed"], 0);
    assert.deepEqual(result["requests"], ["data.json"]);
  });
}

await test("CLV-135 explicit submission shows admission, reuses its command ID after an uncertain reply and does not create a card locally", () => {
  const form = builtinCardForms().find(
    (item) => item.workflowId === "develop-prd",
  );
  const result = played(
    { ...boardModel([], { workflows: ["develop-prd"] }), cardForms: [form] },
    `
location.hash = "#workflow=develop-prd";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
app.all("button").find((node) => node.text === "+ Add a card").dispatch("click");
const submissions = [];
globalThis.fetch = async (address, options) => {
  submissions.push({ address, ...options, body: JSON.parse(options.body) });
  if (submissions.length === 1) throw new Error("lost");
  return { ok: true, json: async () => ({ kind: "result", result: { code: "run-admitted", runId: "run-new" } }) };
};
const area = app.all("textarea")[0];
area.value = "Useful idea";
area.listeners.get("input").call(area, { currentTarget: area, type: "input" });
const submit = () => app.all("form")[0].listeners.get("submit").call(app.all("form")[0], { type: "submit", preventDefault() {} });
submit();
submit();
await settled();
const uncertain = app.inner;
submit();
await settled();
submit();
await settled();
console.log(JSON.stringify({ submissions, uncertain, html: app.inner, cards: app.all("article").filter((node) => node.attributes.get("class") === "card").length }));
`,
  );
  const submissions = result["submissions"];
  assert.ok(Array.isArray(submissions));
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions[0], submissions[1]);
  const sent: unknown = submissions[0];
  assert.equal(Reflect.get(Object(sent), "method"), "POST");
  const body: unknown = Reflect.get(Object(sent), "body");
  assert.deepEqual(Reflect.get(Object(body), "fields"), {
    prompt: "Useful idea",
  });
  assert.match(
    String(Reflect.get(Object(body), "commandId")),
    /^[a-f0-9-]{36}$/,
  );
  assert.match(String(result["uncertain"]), /outcome-unknown/);
  assert.match(String(result["html"]), /Run run-new is admitted/);
  assert.equal(result["cards"], 0);
});

for (const [workflowId, multiline] of [
  ["develop-issue", false],
  ["develop-prd", true],
] as const) {
  await test(`CLV-135 keyboard actions on ${workflowId} require an explicit submit and Escape closes`, () => {
    const form = builtinCardForms().find(
      (item) => item.workflowId === workflowId,
    );
    const result = played(
      { ...boardModel([], { workflows: [workflowId] }), cardForms: [form] },
      `
location.hash = "#workflow=${workflowId}";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
const open = () => app.all("button").find((node) => node.text === "+ Add a card")?.dispatch("click");
open();
let sent = 0;
globalThis.fetch = async () => { sent++; return { ok: true, json: async () => ({ kind: "error", error: { code: "workflow-active" } }) }; };
const key = (value, extra = {}) => {
  const form = app.all("form")[0];
  const target = app.all("${multiline ? "textarea" : "input"}")[0];
  return form.listeners.get("keydown")?.call(form, { type: "keydown", key: value, target, preventDefault() {}, ...extra });
};
key("a");
key("Enter", { isComposing: true });
key("Enter", { repeat: true });
${multiline ? 'key("Enter");' : ""}
const before = sent;
key("Enter", { ${multiline ? "ctrlKey: true" : ""} });
await settled();
const message = app.inner;
key("Escape");
const closed = app.all("form").length;
open();
${multiline ? 'key("Enter", { metaKey: true }); await settled();' : ""}
console.log(JSON.stringify({ before, sent, message, closed }));
`,
    );
    assert.equal(result["before"], 0);
    assert.equal(result["sent"], multiline ? 2 : 1);
    assert.equal(result["closed"], 0);
    assert.match(
      String(result["message"]),
      /workflow-active: Add the label cloving: ready to the issue to put it in the queue/,
    );
  });
}

for (const [label, forms] of [
  ["unknown input", undefined],
  ["off", []],
] as const) {
  await test(`CLV-135 ${label} hides add-card controls`, () => {
    const workflowId = label === "off" ? "develop-prd" : "unknown";
    const result = played(
      { ...boardModel([], { workflows: [workflowId] }), cardForms: forms },
      `
location.hash = "#workflow=${workflowId}";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ add: app.all("button").some((node) => node.text === "+ Add a card"), requests }));
`,
    );
    assert.equal(result["add"], false);
    assert.deepEqual(result["requests"], ["data.json"]);
  });
}

await test("CLV-135 declared workflows render one input for each string field", () => {
  const form = {
    workflowId: "analyze-chats",
    source: "input",
    fields: [
      {
        name: "importId",
        label: "importId",
        multiline: false,
        optional: false,
      },
      { name: "topic", label: "topic", multiline: false, optional: true },
    ],
  };
  const result = played(
    { ...boardModel([], { workflows: [form.workflowId] }), cardForms: [form] },
    `
location.hash = "#workflow=analyze-chats";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
app.all("button").find((node) => node.text === "+ Add a card").dispatch("click");
console.log(JSON.stringify({ labels: app.all("label").map((node) => node.text), inputs: app.all("input").map((node) => node.attributes.get("name")) }));
`,
  );
  assert.deepEqual(result["labels"], ["importId", "topic"]);
  assert.deepEqual(result["inputs"], ["importId", "topic"]);
});
