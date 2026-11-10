import assert from "node:assert/strict";
import { test } from "node:test";
import { played } from "./watch-browser.ts";
import { fields, items } from "./service-fixture.ts";
import { loopModel, loopNow } from "./watch-loops-fixture.ts";

const scenario = `
const model = JSON.parse(process.env.WATCH_MODEL);
const posts = [];
const answers = [];
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method !== "POST") return plain(address, options);
  posts.push({ address, ...options });
  const answer = answers.shift();
  if (answer === undefined) return Promise.reject(new Error("lost"));
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
};
const press = async (node, type) => {
  replies.push(model);
  node.dispatch(type);
  for (let turn = 0; turn < 5; turn++) await settled();
};
const rows = () => app.all("div").filter((node) => (node.getAttribute("class") ?? "").startsWith("line-loop "));
const toggle = (row) => row.all("input")[0];
const runNow = (row) => row.all("button").find((node) => node.text === "Run now");
location.hash = "";
replies.push(model);
await load();
await press(toggle(rows()[0]), "change");
const lost = rows()[0].text;
answers.push({ kind: "schedule", schedule: { state: "paused" } });
await press(toggle(rows()[0]), "change");
answers.push({ kind: "run-admitted", runId: "run-loop", replayed: false });
await press(runNow(rows()[0]), "click");
answers.push({ error: { code: "run-active", detail: "The workflow has an active run." } });
await press(runNow(rows()[0]), "click");
answers.push({ kind: "schedule", schedule: { state: "active" } });
await press(toggle(rows()[1]), "change");
console.log(JSON.stringify({ posts, lost, rows: rows().map((row) => row.text) }));
`;

await test("CLV-328 the page posts each loop click with a random command ID, keeps it for a retry after a lost reply, and shows the reply in the row", () => {
  const result = played(
    { ...loopModel(), cardForms: [], updatedAt: loopNow },
    scenario,
  );
  const posts = items(result["posts"]).map(fields);
  assert.deepEqual(
    posts.map((post) => [post["address"], post["method"]]),
    Array.from({ length: 5 }, () => ["actions/schedule", "POST"]),
  );
  assert.deepEqual(fields(posts[0]?.["headers"]), {
    "content-type": "application/json",
    "x-cloving-token": "a".repeat(64),
  });
  const bodies = posts.map((post) => fields(JSON.parse(String(post["body"]))));
  assert.deepEqual(
    bodies.map((body) => [body["workflowId"], body["action"]]),
    [
      ["review-day", "pause"],
      ["review-day", "pause"],
      ["review-day", "run"],
      ["review-day", "run"],
      ["docs-drift", "resume"],
    ],
  );
  const commandIds = bodies.map((body) => String(body["commandId"]));
  for (const commandId of commandIds)
    assert.match(commandId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(commandIds[1], commandIds[0]);
  assert.equal(new Set(commandIds).size, 4);
  assert.match(String(result["lost"]), /The watch tool does not answer\./);
  const rows = items(result["rows"]).map(String);
  assert.match(rows[0] ?? "", /run-active: The workflow has an active run\.$/);
  assert.match(rows[1] ?? "", /The loop is active\.$/);
});

const unanswered = `
const model = JSON.parse(process.env.WATCH_MODEL);
const posts = [];
const answers = [
  { error: { code: "outcome-unknown", detail: "The connection ended before the reply." } },
  { kind: "schedule", schedule: { state: "paused" } },
  "late",
  { kind: "run-admitted", runId: "run-loop", replayed: true },
  { error: { code: "run-active", detail: "The workflow has an active run." } },
];
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method !== "POST") return plain(address, options);
  posts.push(JSON.parse(options.body));
  const answer = answers.shift();
  if (answer === "late") return Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new Error("text")) });
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
};
const press = async (pick, type) => {
  replies.push(model);
  const row = app.all("div").find((node) => (node.getAttribute("class") ?? "").startsWith("line-loop "));
  pick(row).dispatch(type);
  for (let turn = 0; turn < 5; turn++) await settled();
};
const runNow = (row) => row.all("button").find((node) => node.text === "Run now");
location.hash = "";
replies.push(model);
await load();
await press(runNow, "click");
await press((row) => row.all("input")[0], "change");
await press(runNow, "click");
const late = app.all("div").find((node) => (node.getAttribute("class") ?? "").startsWith("line-loop ")).text;
await press(runNow, "click");
await press(runNow, "click");
console.log(JSON.stringify({ posts, late }));
`;

await test("CLV-328 the page keeps the command ID of Run now after an outcome-unknown reply or a late 503 reply, also after a click on the switch, until a definite reply", () => {
  const result = played(
    { ...loopModel(), cardForms: [], updatedAt: loopNow },
    unanswered,
  );
  const posts = items(result["posts"]).map(fields);
  assert.deepEqual(
    posts.map((post) => post["action"]),
    ["run", "pause", "run", "run", "run"],
  );
  const [lost, paused, late, retried, fresh] = posts.map((post) =>
    String(post["commandId"]),
  );
  assert.equal(late, lost);
  assert.equal(retried, lost);
  assert.match(String(result["late"]), /The watch tool does not answer\./);
  assert.notEqual(paused, lost);
  assert.notEqual(fresh, lost);
});
