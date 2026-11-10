import assert from "node:assert/strict";
import { test } from "node:test";
import { fields, items } from "./service-fixture.ts";
import { played } from "./watch-browser.ts";
import { renameModel } from "./watch-rename-fixture.ts";

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
const press = async (node, type, init) => {
  replies.push(model);
  node.dispatch(type, init);
  for (let turn = 0; turn < 5; turn++) await settled();
};
const button = (text) => app.all("button").find((node) => node.text === text);
const form = () => app.all("form").find((node) => node.getAttribute("class") === "rename-form");
const typed = async (name, value) => {
  const input = form().all("input").find((node) => node.getAttribute("name") === name);
  input.value = value;
  input.dispatch("input");
  for (let turn = 0; turn < 2; turn++) await settled();
};
location.hash = "#run=manual-run";
replies.push(model);
await load();
await press(button("Rename"), "click");
const opened = form().all("input").map((node) => node.getAttribute("value"));
await typed("title", "SID-9: New name");
await typed("label", "");
await press(form(), "submit", { preventDefault() {} });
const lost = app.text;
await press(form(), "submit", { preventDefault() {} });
answers.push({ kind: "run-renamed", runId: "manual-run", title: "SID-9: New name" });
await press(form(), "submit", { preventDefault() {} });
const saved = app.text;
answers.push({ error: { code: "unknown-run", detail: "No run has the ID manual-run." } });
await press(button("Use the automatic name"), "click");
const refused = app.text;
await press(button("Rename"), "click");
await press(form(), "keydown", { key: "Escape", preventDefault() {} });
console.log(JSON.stringify({ posts, opened, lost, saved, refused, closed: form() === undefined }));
`;

await test("CLV-334 Rename posts the title with a random command ID, keeps it for a retry after a lost reply, and Use the automatic name posts clear", () => {
  const result = played({ ...renameModel, cardForms: [] }, scenario);
  assert.deepEqual(result["opened"], ["Own name", "OWN-1"]);
  const posts = items(result["posts"]).map(fields);
  assert.deepEqual(
    posts.map((post) => [post["address"], post["method"]]),
    Array.from({ length: 4 }, () => ["actions/rename", "POST"]),
  );
  assert.deepEqual(fields(posts[0]?.["headers"]), {
    "content-type": "application/json",
    "x-cloving-token": "a".repeat(64),
  });
  const bodies = posts.map((post) => fields(JSON.parse(String(post["body"]))));
  assert.deepEqual(
    bodies.map((body) => [
      body["runId"],
      body["title"],
      body["label"],
      body["clear"],
    ]),
    [
      ["manual-run", "SID-9: New name", undefined, undefined],
      ["manual-run", "SID-9: New name", undefined, undefined],
      ["manual-run", "SID-9: New name", undefined, undefined],
      ["manual-run", undefined, undefined, true],
    ],
  );
  const commands = bodies.map((body) => String(body["commandId"]));
  assert.match(commands[0] ?? "", /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(new Set(commands.slice(0, 3)).size, 1);
  assert.notEqual(commands[3], commands[0]);
  assert.match(String(result["lost"]), /The watch tool does not answer\./);
  assert.match(
    String(result["saved"]),
    /The run has the title SID-9: New name\./,
  );
  assert.match(
    String(result["refused"]),
    /unknown-run: No run has the ID manual-run\./,
  );
  assert.equal(result["closed"], true);
});
