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

async function withServiceWatch(
  body: (
    harness: Harness,
    opened: Awaited<ReturnType<Harness["start"]>>,
  ) => Promise<void>,
): Promise<void> {
  await withHarness(async (harness) => body(harness, await harness.start()));
}

await test("CLV-336 Approve on the page records the decision with the fields of the model, the item leaves Needs you, and the receipt equals the receipt of cloving_approve with the same command ID", () =>
  withServiceWatch(async (harness, service) => {
    const { runId } = await waitingGate(harness, {
      service,
      commandId: "gate-a",
      kind: "approval",
    });
    const watch = await watching(harness.runtimeDirectory);
    try {
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
      const page = await posted(watch, {
        command: "approve",
        ...binding,
        commandId: "page-1",
      });
      assert.equal(page["kind"], "decision-recorded");
      assert.equal(page["decision"], "approved");
      assert.equal(page["replayed"], false);
      const mcp = await callTool({
        runtime: harness.runtimeDirectory,
        name: "cloving_approve",
        arguments: { ...binding, commandId: "page-1" },
      });
      const content = fields(mcp["structuredContent"]);
      assert.equal(content["replayed"], true);
      assert.deepEqual(content["receipt"], page["receipt"]);
      assert.deepEqual({ ...content, replayed: false }, page);
      const after = runOf(await watchData(watch.address), runId);
      assert.deepEqual(after["decisions"], []);
      assert.notEqual(after["state"], "waiting_gate");
    } finally {
      await watch.stop();
    }
  }));

await test("CLV-336 Send the answer on the page records the answer of a question", () =>
  withServiceWatch(async (harness, service) => {
    const { runId } = await waitingGate(harness, {
      service,
      commandId: "gate-q",
      kind: "question",
    });
    const watch = await watching(harness.runtimeDirectory);
    try {
      const decision = await pageDecision(watch, runId);
      assert.deepEqual(decision["replies"], ["answer"]);
      const page = await posted(watch, {
        command: "answer",
        ...bindingOf(decision),
        text: "Use the parser.",
        commandId: "page-answer",
      });
      assert.equal(page["decision"], "answered");
      assert.deepEqual(await pageDecision(watch, runId), {});
    } finally {
      await watch.stop();
    }
  }));
