import assert from "node:assert/strict";
import { test } from "node:test";
import {
  watchHash,
  watchLocation,
  watchTitle,
} from "../src/cli/watch-navigation.ts";
import { pageTitle } from "../src/cli/watch-render.ts";
import { activeBoardModel, completionScenario } from "./watch-board-fixture.ts";
import { played } from "./watch-browser.ts";

const model = { ...activeBoardModel(), startWorkflowId: "develop-ticket" };

await test("CLV-091 the original and later card links each navigate to their own run", () => {
  const model = completionScenario({ stopped: "A /&", later: "B /&" });
  const result = played(
    model,
    `
const model = JSON.parse(process.env.WATCH_MODEL);
const pages = [];
for (const runId of ["A /&", "B /&"]) {
  location.hash = "#workflow=develop-issue";
  replies.push(model);
  await load();
  const href = "#workflow=develop-issue&run=" + encodeURIComponent(runId);
  const link = app.all("a").find((item) => item.attributes.get("href") === href && (runId.startsWith("A") || item.inner === "Done in a later run"));
  if (!link) throw new Error("missing run link " + href);
  link.dispatch("click");
  location.hash = link.attributes.get("href");
  replies.push(model);
  listeners.hashchange();
  await settled();
  pages.push({ hash: location.hash, html: app.inner });
}
console.log(JSON.stringify({ pages }));
`,
  );
  const pages = JSON.stringify(result["pages"]);
  assert.match(pages, /run=A%20%2F%26/);
  assert.match(pages, /run=B%20%2F%26/);
  assert.match(pages, /A \/&amp;/);
  assert.match(pages, /B \/&amp;/);
  assert.doesNotMatch(pages, /Done in a later run|Needs attention/);
});

await test("CLV-079 absent and unknown workflows show the starting board without changing the hash", () => {
  const result = played(
    model,
    `
const model = JSON.parse(process.env.WATCH_MODEL);
const pages = [];
for (const hash of ["", "#workflow=missing", "#workflow=develop-issue"]) {
  location.hash = hash;
  replies.push(model);
  await load();
  pages.push({ hash: location.hash, html: app.inner, title: document.title });
}
console.log(JSON.stringify({ pages, requests, scrolled }));
`,
  );
  const pages = result["pages"];
  assert.ok(Array.isArray(pages));
  assert.deepEqual(
    pages.map((page: unknown): string => {
      assert.ok(typeof page === "object" && page !== null && "hash" in page);
      assert.ok(typeof page.hash === "string");
      return page.hash;
    }),
    ["", "#workflow=missing", "#workflow=develop-issue"],
  );
  assert.match(JSON.stringify(pages.slice(0, 2)), /develop-ticket · Cloving/);
  assert.match(JSON.stringify(pages[2]), /develop-issue · Cloving/);
  assert.deepEqual(result["requests"], ["data.json", "data.json", "data.json"]);
  assert.deepEqual(result["scrolled"], []);
});

await test("CLV-079 workflow, card and back links navigate between the board and the full run", () => {
  const result = played(
    model,
    `
const model = JSON.parse(process.env.WATCH_MODEL);
location.hash = "";
replies.push(model);
await load();
async function click(href) {
  const link = app.all("a").find((item) => item.attributes.get("href") === href);
  if (!link) throw new Error("missing link " + href);
  link.dispatch("click");
  location.hash = link.attributes.get("href");
  replies.push(model);
  listeners.hashchange();
  await settled();
  return { hash: location.hash, html: app.inner };
}
const board = await click("#workflow=develop-issue");
const run = await click("#workflow=develop-issue&run=round-2");
const back = await click("#workflow=develop-issue");
console.log(JSON.stringify({ board, run, back }));
`,
  );
  const board = JSON.stringify(result["board"]);
  const run = JSON.stringify(result["run"]);
  assert.match(board, /#workflow=develop-issue/);
  assert.match(board, /Title of round-2/);
  assert.match(run, /#workflow=develop-issue&run=round-2/);
  assert.match(run, /← Back to develop-issue/);
  assert.doesNotMatch(run, /class=\\"workflows|class=\\"run /);
  assert.deepEqual(result["back"], result["board"]);
});

await test("CLV-079 unavailable saved runs show a full page with the requested or starting board back link", () => {
  const result = played(
    model,
    `
const model = JSON.parse(process.env.WATCH_MODEL);
const pages = [];
for (const hash of ["#missing", "#workflow=develop-issue&run=missing"]) {
  location.hash = hash;
  replies.push(model, null);
  await load();
  pages.push(app.inner);
}
console.log(JSON.stringify({ pages, requests }));
`,
  );
  const pages = result["pages"];
  assert.ok(Array.isArray(pages));
  assert.match(
    String(pages[0]),
    /href="#workflow=develop-ticket">← Back to develop-ticket/,
  );
  assert.match(
    String(pages[1]),
    /href="#workflow=develop-issue">← Back to develop-issue/,
  );
  for (const page of pages) {
    assert.match(String(page), /This run is not available/);
    assert.doesNotMatch(String(page), /class="workflows"|class="run /);
  }
});

await test("CLV-079 board titles count waiting runs across workflows", () => {
  const waiting = {
    ...model,
    workflows: model.workflows.map((workflow) => ({
      ...workflow,
      waitingCount: 2,
    })),
  };
  const result = played(
    waiting,
    `
location.hash = "#workflow=develop-issue";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
console.log(JSON.stringify({ title: document.title }));
`,
  );
  assert.equal(result["title"], "(6) develop-issue · Cloving");
  assert.equal(watchTitle(waiting, "workflow=develop-issue"), result["title"]);
});

await test("CLV-079 navigation preserves encoded workflow and run IDs and malformed legacy links", () => {
  const location = { workflowId: "workflow /&+", runId: "run /&+" };
  const hash = "#workflow=workflow%20%2F%26%2B&run=run%20%2F%26%2B";
  assert.equal(watchHash(location), hash);
  assert.deepEqual(watchLocation(hash), location);
  assert.deepEqual(watchLocation("#old%20%2F%26run"), {
    workflowId: null,
    runId: "old /&run",
  });
  assert.deepEqual(watchLocation("#old%invalid"), {
    workflowId: null,
    runId: "old%invalid",
  });
  assert.deepEqual(watchLocation("#workflow=&run="), {
    workflowId: null,
    runId: null,
  });
  assert.equal(watchHash({ workflowId: null, runId: "old" }), "#run=old");
});

await test("CLV-079 titles keep run status on full pages and handle an empty workflow registry", () => {
  assert.equal(
    watchTitle(model, "workflow=develop-issue"),
    "develop-issue · Cloving",
  );
  assert.equal(
    watchTitle(model, "workflow=develop-issue&run=round-2"),
    pageTitle(model, "round-2"),
  );
  assert.equal(
    watchTitle({ ...model, workflows: [], startWorkflowId: null }, ""),
    "Cloving",
  );
});
