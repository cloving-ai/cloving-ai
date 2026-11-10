import assert from "node:assert/strict";
import { test } from "node:test";
import type { DecisionControls } from "../src/cli/watch-decision-view.ts";
import { component } from "../src/cli/watch-element.ts";
import { watchHash, watchLocation } from "../src/cli/watch-navigation.ts";
import type { WatchDecision, WatchModel } from "../src/cli/watch-render.ts";
import { Page } from "../src/cli/watch-view.ts";
import { found, rendered } from "./watch-dom.ts";
import {
  decisionFor,
  draftRun,
  floorModel,
  needsModel,
} from "./watch-floor-fixture.ts";
import { at, noCopy, sampleDecision, sampleRun } from "./watch-sample.ts";

const question: WatchDecision = {
  ...sampleDecision,
  decisionId: "run-1/design-1",
  reference: "run-1/design-1",
  type: "question",
  prompt: "Which <parser> do we keep?",
  replies: ["answer"],
};

function controls(calls: string[]): DecisionControls {
  return {
    busy: [],
    messages: { "run-1": "Approved" },
    answers: { "run-1/design-1": "The new one." },
    onAnswer: (answer) =>
      calls.push(`text ${answer.decisionId} ${answer.text}`),
    onReply: (choice) =>
      calls.push(`${choice.reply} ${choice.decision.decisionId}`),
  };
}

function model(decision: WatchDecision): WatchModel {
  return {
    updatedAt: at("21:34:41"),
    service: "up",
    workflows: [],
    runs: [
      sampleRun({
        decisions: [{ ...decision, openedAt: at("21:22:41") }],
      }),
    ],
  };
}

function page(shown: WatchModel, deciding?: DecisionControls) {
  return component(Page, {
    model: shown,
    selected: "run=run-1",
    now: shown.updatedAt,
    stale: false,
    copying: noCopy,
    ...(deciding === undefined ? {} : { deciding }),
  });
}

function call(value: unknown, event: unknown): void {
  if (typeof value === "function") Reflect.apply(value, undefined, [event]);
}

function button(
  node: unknown,
  text: string,
): Readonly<Record<string, unknown>> {
  return found(node, "button").find((item) => item["children"] === text) ?? {};
}

await test("CLV-336 an approval shows at the top of the run detail with its full text open, Approve and Deny buttons, the reply line and the copy commands below the buttons", () => {
  const calls: string[] = [];
  const shown = page(model(sampleDecision), controls(calls));
  const html = rendered(shown);
  const order = [
    '<section class="banner attention">',
    '<p class="decision-reply" role="status">Approved</p>',
    '<section class="decision" id="decision-run-1/review-1"><h3>Your decision · approval · waiting 12m</h3><pre class="request">Review &lt;b&gt;this&lt;/b&gt; &amp; that.</pre>',
    '<div class="decision-replies"><button type="button" class="decision-approve">Approve</button><button type="button" class="decision-deny">Deny</button></div>',
    '<span class="label code-head">Approve</span>',
    '<span class="label code-head">Deny</span>',
    '<ol class="phases">',
  ].map((part) => html.indexOf(part));
  assert.ok(
    order.every((index) => index >= 0),
    html,
  );
  assert.deepEqual(
    order,
    order.toSorted((first, second) => first - second),
  );
  assert.doesNotMatch(html, /Full text of the request|<textarea/);
  call(button(shown, "Approve")["onClick"], {});
  call(button(shown, "Deny")["onClick"], {});
  assert.deepEqual(calls, ["approve run-1/review-1", "deny run-1/review-1"]);
  const busy = page(model(sampleDecision), {
    ...controls([]),
    busy: ["run-1/review-1"],
  });
  assert.equal(button(busy, "Approve")["disabled"], true);
  assert.equal(button(busy, "Deny")["disabled"], true);
});

await test("CLV-336 a question has a text field with its answer, Send the answer submits it, and its copy command is the answer command", () => {
  const calls: string[] = [];
  const shown = page(model(question), controls(calls));
  const html = rendered(shown);
  assert.match(
    html,
    /<h3>Your decision · question · waiting 12m<\/h3><pre class="request">Which &lt;parser&gt; do we keep\?<\/pre><form class="decision-answer"><label>Your answer<textarea id="answer-run-1\/design-1" name="answer" value="The new one\."><\/textarea><\/label><button type="submit">Send the answer<\/button><\/form>/,
  );
  assert.match(html, /<span class="label code-head">Answer<\/span>/);
  assert.doesNotMatch(html, />Approve<|>Deny</);
  const [form] = found(shown, "form");
  const [field] = found(shown, "textarea");
  assert.equal(field?.["rows"], 4);
  call(field["onInput"], { currentTarget: { value: "Keep the old one." } });
  call(form?.["onSubmit"], { preventDefault: () => calls.push("prevented") });
  assert.deepEqual(calls, [
    "text run-1/design-1 Keep the old one.",
    "prevented",
    "answer run-1/design-1",
  ]);
});

await test("CLV-336 with watch actions off the decision shows no control and keeps the copy commands", () => {
  for (const decision of [sampleDecision, question]) {
    const html = rendered(page(model(decision)));
    assert.doesNotMatch(
      html,
      /<button type="(?:submit|button)" class="decision|<textarea|<form/,
    );
    assert.match(html, /<div class="command code-window">/);
    assert.match(html, /<pre class="request">/);
  }
});

await test("CLV-336 a private question shows only its preview, says that the full text is on the paired phones, and has no text field", () => {
  const html = rendered(
    page(
      model({
        ...question,
        private: true,
        prompt: "Private analysis question. Run cloving questions to view it.",
      }),
      controls([]),
    ),
  );
  assert.match(
    html,
    /<pre class="request">Private analysis question\. Run cloving questions to view it\.<\/pre><p class="meta">The full text is on your paired phones\.<\/p>/,
  );
  assert.doesNotMatch(html, /<textarea|Send the answer/);
});

await test("CLV-336 a decision link names the run and the decision, and the page reads the decision from it", () => {
  const hash = watchHash({
    workflowId: null,
    runId: "run-1",
    decisionId: "run-1/design-1",
  });
  assert.equal(hash, "#run=run-1&decision=run-1%2Fdesign-1");
  assert.deepEqual(watchLocation(hash), {
    workflowId: null,
    runId: "run-1",
    decisionId: "run-1/design-1",
  });
  assert.deepEqual(watchLocation("#run=run-1"), {
    workflowId: null,
    runId: "run-1",
  });
});

function floor(shown: WatchModel, deciding?: DecisionControls) {
  return component(Page, {
    model: shown,
    selected: "",
    now: shown.updatedAt,
    stale: false,
    copying: noCopy,
    ...(deciding === undefined ? {} : { deciding }),
  });
}

await test("CLV-336 in Needs you an approval has Approve and Deny, Answer opens the decision, and a paused run shows the reason of the pause", () => {
  const calls: string[] = [];
  const shown = floor(
    needsModel({ decision: 12, stopped: 51 }),
    controls(calls),
  );
  const html = rendered(shown);
  assert.match(
    html,
    /<button type="button" class="need-action need-approve">Approve<\/button><button type="button" class="need-action need-deny">Deny<\/button><a class="need-action" href="#run=draft&amp;decision=draft%2Freview-1">Answer<\/a>/,
  );
  assert.match(
    html,
    /<p class="need-reason">Why it paused: operator-pause: The operator paused the run\.<\/p>/,
  );
  call(button(shown, "Approve")["onClick"], {});
  call(button(shown, "Deny")["onClick"], {});
  assert.deepEqual(calls, ["approve draft/review-1", "deny draft/review-1"]);
  assert.doesNotMatch(
    rendered(floor(needsModel({ decision: 12, stopped: 51 }))),
    /need-approve/,
  );
  const asked = floorModel([draftRun(3)], {
    decisions: [decisionFor("draft", { type: "question", minutes: 3 })],
  });
  assert.doesNotMatch(rendered(floor(asked, controls([]))), /need-approve/);
});
