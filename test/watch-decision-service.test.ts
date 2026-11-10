import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fields } from "../src/protocol.ts";
import { actionHeaders, pageToken, postCard } from "./watch-action-fixture.ts";
import { watching, type Watching } from "./watch-fixture.ts";
import { watchData } from "./watch-service-fixture.ts";
import { callTool } from "./mcp-fixture.ts";
import {
  fields,
  items,
  waitingGate,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

function runOf(model: Fields, runId: string): Fields {
  return fields(
    items(model["runs"]).find((run) => fields(run)["runId"] === runId),
  );
}

function bindingOf(decision: Fields): Fields {
  return {
    reference: decision["reference"],
    expectedRevision: decision["expectedRevision"],
    generation: decision["generation"],
    subjectDigest: decision["subjectDigest"],
  };
}

async function pageDecision(watch: Watching, runId: string): Promise<Fields> {
  const [decision] = items(
    runOf(await watchData(watch.address), runId)["decisions"],
  );
  return fields(decision);
}

async function posted(watch: Watching, body: Fields): Promise<Fields> {
  const reply = await postCard(watch, {
    path: "actions/decision",
    headers: actionHeaders(watch, await pageToken(watch)),
    body: JSON.stringify(body),
  });
  assert.equal(reply.status, 200, reply.body);
  return fields(JSON.parse(reply.body));
}

async function approvedOnPage(
  harness: Harness,
  page: { readonly watch: Watching; readonly runId: string },
): Promise<void> {
  const { watch, runId } = page;
  const decision = await pageDecision(watch, runId);
  assert.deepEqual(decision["replies"], ["approve", "deny"]);
  const binding = bindingOf(decision);
  const stale = await posted(watch, {
    command: "approve",
    ...binding,
    expectedRevision: Number(binding["expectedRevision"]) + 1,
    commandId: "page-stale",
  });
  assert.equal(stale["code"], "stale-revision");
  const approved = await posted(watch, {
    command: "approve",
    ...binding,
    commandId: "page-1",
  });
  assert.equal(approved["kind"], "decision-recorded");
  assert.equal(approved["decision"], "approved");
  assert.equal(approved["replayed"], false);
  const mcp = await callTool({
    runtime: harness.runtimeDirectory,
    name: "cloving_approve",
    arguments: { ...binding, commandId: "page-1" },
  });
  const content = fields(mcp["structuredContent"]);
  assert.equal(content["replayed"], true);
  assert.deepEqual(content["receipt"], approved["receipt"]);
  assert.deepEqual({ ...content, replayed: false }, approved);
  const after = runOf(await watchData(watch.address), runId);
  assert.deepEqual(after["decisions"], []);
  assert.notEqual(after["state"], "waiting_gate");
}

async function answeredOnPage(watch: Watching, runId: string): Promise<void> {
  const decision = await pageDecision(watch, runId);
  assert.deepEqual(decision["replies"], ["answer"]);
  const answered = await posted(watch, {
    command: "answer",
    ...bindingOf(decision),
    text: "Use the parser.",
    commandId: "page-answer",
  });
  assert.equal(answered["decision"], "answered");
  assert.deepEqual(await pageDecision(watch, runId), {});
}

await test("CLV-336 Approve on the page records the decision with the fields of the model, the item leaves Needs you, the receipt equals the receipt of cloving_approve with the same command ID, and Send the answer records the answer of a question", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const approval = await waitingGate(harness, {
      service,
      commandId: "gate-a",
      kind: "approval",
    });
    const question = await waitingGate(harness, {
      service,
      commandId: "gate-q",
      kind: "question",
    });
    const watch = await watching(harness.runtimeDirectory);
    try {
      await approvedOnPage(harness, { watch, runId: approval.runId });
      await answeredOnPage(watch, question.runId);
    } finally {
      await watch.stop();
    }
  }));
