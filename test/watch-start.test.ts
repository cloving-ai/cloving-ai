import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { Page } from "../src/cli/watch-view.ts";
import { boardModel, boardRun } from "./watch-board-fixture.ts";
import { found, rendered } from "./watch-dom.ts";
import { noCopy } from "./watch-sample.ts";
import { played } from "./watch-browser.ts";

const prompts = [
  {
    workflowId: "develop-issue",
    sentence: "Work on a GitHub issue through a pull request.",
    prompt: `Start a Cloving run for a GitHub issue in this repository.
Run: cloving run develop-issue --ticket ISSUE_NUMBER
Use the issue number that I give on the last line.
Report the run ID. Then run cloving status RUN_ID until the run completes or stops, and tell me the result and the pull request.
Do not push, merge or change labels yourself.
Issue number:`,
  },
  {
    workflowId: "develop-ticket",
    sentence: "Work on a ticket with your review of the diff.",
    prompt: `Start a Cloving run for a ticket in this repository.
Run: cloving run develop-ticket --ticket TICKET_ID
Use the ticket ID that I give on the last line.
When the run waits for a decision, run cloving questions, show me the diff and the decision, and give me the approve and deny commands.
Run only the command that I choose. Do not decide for me.
Ticket ID:`,
  },
  {
    workflowId: "develop-prd",
    sentence: "Turn an idea into a GitHub issue.",
    prompt: `Start a Cloving run that turns an idea into a GitHub issue.
Run: cloving run develop-prd --prompt "IDEA"
Use the idea that I give on the last line as IDEA.
When the run completes, show me the new issue.
Add the label cloving: ready only when I tell you to.
Idea:`,
  },
  {
    workflowId: "develop-prompt",
    sentence: "Do a small task with your review of the diff.",
    prompt: `Start a Cloving run for a small task in this repository.
Run: cloving run develop-prompt --prompt "TASK"
Use the task that I give on the last line as TASK.
When the run waits for a decision, run cloving questions, show me the diff, and give me the approve and deny commands.
Run only the command that I choose. Do not decide for me.
Task:`,
  },
];

await test("CLV-106 the board starts with four registered workflow cards and their exact agent prompts", () => {
  const model = boardModel([], {
    workflows: prompts.map((item) => item.workflowId),
  });
  const shown = component(Page, {
    model,
    selected: "workflow=develop-issue",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
  });
  const cards = found(shown, "article");
  assert.equal(cards.length, 4);
  for (const [index, expected] of prompts.entries()) {
    const card = cards[index]?.["children"];
    assert.equal(
      rendered(found(card, "h3")[0]?.["children"]),
      expected.workflowId,
    );
    assert.equal(
      rendered(found(card, "p")[0]?.["children"]),
      expected.sentence,
    );
    assert.equal(found(card, "code")[0]?.["children"], expected.prompt);
    assert.equal(found(card, "button")[0]?.["children"], "Copy the prompt");
    assert.match(rendered(card), /class="command code-window"/);
  }
});

await test("CLV-134 the start section is hidden by default with a header toggle", () => {
  const model = boardModel([], { workflows: ["develop-issue"] });
  const shown = component(Page, {
    model,
    selected: "workflow=develop-issue",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
  });
  const section = found(shown, "section").find(
    (item) => item["class"] === "start-run",
  );
  assert.equal(section?.["hidden"], true);
  const header = found(shown, "header")[0];
  const toggle = found(header?.["children"], "button")[0];
  assert.equal(toggle?.["children"], "Start a run");
  assert.equal(toggle["aria-expanded"], "false");
  assert.equal(toggle["aria-controls"], section["id"]);
  const html = rendered(shown);
  assert.ok(html.indexOf("Start a run") < html.indexOf('class="workflows"'));
  assert.ok(html.indexOf("Start a run") < html.indexOf('class="board"'));
});

await test("CLV-134 the header shows and hides start prompts and remembers a shown state on reload", () => {
  const result = played(
    boardModel([], { workflows: ["develop-issue"] }),
    `
const saved = new Map();
globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
location.hash = "#workflow=develop-issue";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
const toggle = () => app.all("button").find((node) => node.text === "Start a run");
const hidden = () => app.all("section").find((node) => node.attributes.get("class") === "start-run")?.attributes.has("hidden");
const initial = hidden();
toggle().dispatch("click");
const opened = hidden();
state.start = null;
draw();
const restored = hidden();
toggle().dispatch("click");
state.start = null;
draw();
console.log(JSON.stringify({ initial, opened, restored, closed: hidden(), expanded: toggle().attributes.get("aria-expanded"), saved: [...saved], requests }));
`,
  );
  assert.equal(result["initial"], true);
  assert.equal(result["opened"], false);
  assert.equal(result["restored"], false);
  assert.equal(result["closed"], true);
  assert.equal(result["expanded"], "false");
  assert.deepEqual(result["saved"], [["cloving.watch.start", "false"]]);
  assert.deepEqual(result["requests"], ["data.json"]);
});

for (const store of ["missing", "denied", "broken", "invalid", "shown"]) {
  await test(`CLV-134 start prompts use a safe default for ${store} storage`, () => {
    const result = played(
      boardModel([], { workflows: ["develop-issue"] }),
      `
const mode = ${JSON.stringify(store)};
if (mode === "denied") Object.defineProperty(globalThis, "localStorage", { get() { throw new Error("denied"); } });
if (["broken", "invalid", "shown"].includes(mode)) globalThis.localStorage = { getItem: () => mode === "shown" ? "true" : mode === "broken" ? "{" : '"true"', setItem() { throw new Error("full"); } };
location.hash = "#workflow=develop-issue";
replies.push(JSON.parse(process.env.WATCH_MODEL));
await load();
const hidden = () => app.all("section").find((node) => node.attributes.get("class") === "start-run")?.attributes.has("hidden");
const initial = hidden();
app.all("button").find((node) => node.text === "Start a run")?.dispatch("click");
draw();
console.log(JSON.stringify({ initial, changed: hidden() }));
`,
    );
    assert.equal(result["initial"], store !== "shown");
    assert.equal(result["changed"], store === "shown");
  });
}

await test("CLV-106 only develop-issue has a start card when it is the only registered workflow", () => {
  const model = boardModel([], { workflows: ["develop-issue"] });
  const shown = component(Page, {
    model,
    selected: "workflow=develop-issue",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
  });
  const cards = found(shown, "article");
  assert.equal(cards.length, 1);
  assert.equal(
    found(cards[0]?.["children"], "code")[0]?.["children"],
    prompts[0]?.prompt,
  );
});

await test("CLV-106 each start button copies the exact prompt with feedback and only watch reads", () => {
  const model = boardModel([], {
    workflows: prompts.map((item) => item.workflowId),
  });
  const result = played(
    model,
    `
const model = JSON.parse(process.env.WATCH_MODEL);
location.hash = "#workflow=develop-issue";
replies.push(model);
await load();
app.all("button").find((node) => node.text === "Start a run").dispatch("click");
const buttons = app.all("button").filter((node) => node.text === "Copy the prompt");
const labels = [];
for (const button of buttons) {
  labels.push(button.text);
  button.dispatch("click");
  await settled();
  labels.push(button.text);
}
navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
buttons[0].dispatch("click");
await settled();
console.log(JSON.stringify({ copied, labels, failed: buttons[0].text, requests, streams: sources.map((source) => source.address), inputs: app.all("input").length, forms: app.all("form").length }));
`,
  );
  assert.deepEqual(
    result["copied"],
    prompts.map((item) => item.prompt),
  );
  assert.deepEqual(
    result["labels"],
    prompts.flatMap(() => ["Copy the prompt", "Copied"]),
  );
  assert.equal(result["failed"], "Copy failed");
  assert.deepEqual(result["requests"], ["data.json"]);
  assert.deepEqual(result["streams"], ["events"]);
  assert.equal(result["inputs"], 0);
  assert.equal(result["forms"], 0);
});

for (const workflows of [
  [],
  ["custom-workflow"],
  ["develop-issue", "custom-workflow"],
]) {
  await test(`CLV-106 start cards exclude unknown workflows from ${workflows.join(", ") || "an empty registry"}`, () => {
    const model = boardModel([], { workflows });
    const shown = component(Page, {
      model,
      selected: "",
      now: model.updatedAt,
      stale: false,
      copying: noCopy,
    });
    const cards = found(shown, "article");
    assert.equal(cards.length, workflows.includes("develop-issue") ? 1 : 0);
    assert.doesNotMatch(rendered(cards), /custom-workflow/);
  });
}

await test("CLV-106 start prompts do not change the run detail page", () => {
  const model = boardModel([boardRun("run-1")]);
  const shown = component(Page, {
    model,
    selected: "workflow=develop-issue&run=run-1",
    now: model.updatedAt,
    stale: false,
    copying: noCopy,
  });
  assert.doesNotMatch(rendered(shown), /Start a run|Copy the prompt/);
  assert.match(rendered(shown), /class="banner working"/);
});
