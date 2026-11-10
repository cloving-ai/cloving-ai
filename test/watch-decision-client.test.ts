import assert from "node:assert/strict";
import { test } from "node:test";
import type { WatchDecision } from "../src/cli/watch-render.ts";
import { played } from "./watch-browser.ts";
import { sampleDecision, sampleModel, sampleRun } from "./watch-sample.ts";

const question: WatchDecision = {
  ...sampleDecision,
  decisionId: "run-1/design-1",
  reference: "run-1/design-1",
  type: "question",
  prompt: "Which parser do we keep?",
  replies: ["answer"],
};

function postsOf(result: Record<string, unknown>): readonly unknown[][] {
  const posts = result["posts"];
  return Array.isArray(posts)
    ? posts.map((post: unknown) =>
        Array.isArray(post) ? post.map((item: unknown) => item) : [],
      )
    : [];
}

function bodyOf(post: readonly unknown[] | undefined): Record<string, unknown> {
  const body = post?.[1];
  return typeof body === "object" && body !== null ? { ...body } : {};
}

function model(decision: WatchDecision) {
  return {
    ...sampleModel([sampleRun({ decisions: [decision] })]),
    cardForms: [],
  };
}

const capture = `
const model = JSON.parse(process.env.WATCH_MODEL);
const posts = [];
const plain = globalThis.fetch;
globalThis.fetch = (address, options) => {
  if (options?.method === "POST") posts.push([address, JSON.parse(options.body), options.headers["x-cloving-token"]]);
  return plain(address, options);
};
const button = (text) => app.all("button").find((node) => node.inner === text);
const line = () => app.all("p").find((node) => node.getAttribute("class") === "decision-reply")?.inner ?? null;
const wait = async () => { for (let turn = 0; turn < 6; turn++) await settled(); };
const recorded = { schemaVersion: 1, kind: "decision-recorded", replayed: false };
`;

await test("CLV-336 Approve in Needs you posts one decision request with the fields of the decision, keeps the command ID for a retry after a lost reply, and shows Approved", () => {
  const result = played(
    model(sampleDecision),
    `${capture}
location.hash = "";
replies.push(model);
await load();
button("Approve").dispatch("click");
await wait();
const lost = app.all("p").find((node) => node.getAttribute("class") === "need-message")?.inner ?? null;
replies.push(recorded, model);
button("Approve").dispatch("click");
await wait();
const shown = app.all("p").find((node) => node.getAttribute("class") === "need-message")?.inner ?? null;
replies.push(recorded, model);
button("Deny").dispatch("click");
await wait();
console.log(JSON.stringify({ posts, lost, shown }));
`,
  );
  const posts = postsOf(result);
  const binding = {
    reference: "run-1/review-1",
    expectedRevision: 1,
    generation: 1,
    subjectDigest: sampleDecision.subjectDigest,
  };
  assert.deepEqual(
    posts.map((post) => [
      post[0],
      { ...bodyOf(post), commandId: typeof bodyOf(post)["commandId"] },
      post[2],
    ]),
    [
      [
        "actions/decision",
        { command: "approve", ...binding, commandId: "string" },
        "a".repeat(64),
      ],
      [
        "actions/decision",
        { command: "approve", ...binding, commandId: "string" },
        "a".repeat(64),
      ],
      [
        "actions/decision",
        { command: "deny", ...binding, commandId: "string" },
        "a".repeat(64),
      ],
    ],
  );
  const ids = posts.map((post) => bodyOf(post)["commandId"]);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[1], ids[2]);
  assert.equal(
    result["lost"],
    "The watch tool does not answer. Click again to send the same request.",
  );
  assert.equal(result["shown"], "Approved");
});

await test("CLV-336 Send the answer refuses a blank text in the page with no request, then posts the trimmed answer and shows Answer sent", () => {
  const result = played(
    model(question),
    `${capture}
location.hash = "#run=run-1";
replies.push(model);
await load();
const form = () => app.all("form").find((node) => node.getAttribute("class") === "decision-answer");
const field = () => app.all("textarea")[0];
field().value = "   ";
field().dispatch("input");
form().dispatch("submit", { preventDefault: () => undefined });
await wait();
const blank = line();
field().value = "  Keep the new parser.  ";
field().dispatch("input");
replies.push(recorded, model);
form().dispatch("submit", { preventDefault: () => undefined });
await wait();
console.log(JSON.stringify({ posts, blank, sent: line(), text: field().value }));
`,
  );
  const posts = postsOf(result);
  assert.equal(result["blank"], "Write an answer of 1 to 4000 characters.");
  assert.equal(posts.length, 1);
  assert.equal(bodyOf(posts[0])["command"], "answer");
  assert.equal(bodyOf(posts[0])["text"], "Keep the new parser.");
  assert.equal(result["sent"], "Answer sent");
  assert.equal(result["text"], "");
});

await test("CLV-336 a changed decision shows The decision changed. Read it again. with the new decision, and a refusal shows its code and detail", () => {
  const changed = model({ ...sampleDecision, prompt: "Review round 2." });
  const result = played(
    model(sampleDecision),
    `${capture}
const changed = ${JSON.stringify(changed)};
location.hash = "#run=run-1";
replies.push(model);
await load();
replies.push({ schemaVersion: 1, kind: "error", code: "stale-revision", detail: "stale" }, changed);
button("Approve").dispatch("click");
await wait();
const stale = [line(), app.all("pre").find((node) => node.getAttribute("class") === "request")?.inner];
replies.push({ schemaVersion: 1, kind: "error", code: "decision-not-pending", detail: "No pending decision matches run-1/review-1." }, changed);
button("Deny").dispatch("click");
await wait();
const pending = line();
replies.push(null, changed);
button("Deny").dispatch("click");
await wait();
const refused = line();
console.log(JSON.stringify({ stale, refused: [pending, refused] }));
`,
  );
  assert.deepEqual(result["stale"], [
    "The decision changed. Read it again.",
    "Review round 2.",
  ]);
  assert.deepEqual(result["refused"], [
    "decision-not-pending: No pending decision matches run-1/review-1.",
    "The watch page refused the request. Refresh the page.",
  ]);
});

await test("CLV-336 a decision link scrolls to the decision and puts the focus in its text field once", () => {
  const result = played(
    model(question),
    `${capture}
const seen = [];
document.getElementById = (id) => id === "app" ? app : { focus: () => seen.push("focus " + id), scrollIntoView: () => seen.push("scroll " + id), querySelector: () => null };
location.hash = "#run=run-1&decision=run-1%2Fdesign-1";
replies.push(model);
await load();
replies.push(model);
await load();
console.log(JSON.stringify({ seen }));
`,
  );
  assert.deepEqual(result["seen"], [
    "scroll decision-run-1/design-1",
    "focus answer-run-1/design-1",
  ]);
});
