import { feedWorkflow } from "./service-feed-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { queryDatabase } from "./authority-store-fixture.ts";
import { call, field, text, withHarness } from "./service-fixture.ts";

const pick = { id: "800", text: "# Queue task\n\nKeep the text exactly.  " };

function request(commandId: string, ticket: unknown = pick) {
  return {
    operation: "run",
    parameters: {
      workflowId: "develop",
      source: "feed",
      submission: { ticket },
      commandId,
    },
  };
}

await test("CLV-362 feed work preserves maximum UTF-8 text after JSON escaping", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [feedWorkflow(harness.registration)],
    });
    const ticket = { id: "800", text: "\u0000".repeat(65_536) };
    const reply = await call(harness, request("escaped-feed", ticket));
    assert.equal(reply["kind"], "run-admitted", JSON.stringify(reply));
    await service.close();
    const documents = queryDatabase(
      harness.stateDirectory,
      "SELECT digest, body FROM documents",
    );
    const input = documents.find(
      (document) =>
        field(document, "digest") ===
        field(reply["binding"], "executionInputDigest"),
    );
    assert.deepEqual(field(JSON.parse(text(input, "body")), "input"), {
      ticket,
    });
  }));

await test("CLV-362 a feed pick admits the exact declared work input without a ticket command", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [feedWorkflow(harness.registration)],
    });
    const reply = await call(harness, request("feed-pick"));
    assert.equal(reply["kind"], "run-admitted", JSON.stringify(reply));
    await service.close();
    const documents = queryDatabase(
      harness.stateDirectory,
      "SELECT digest, body FROM documents",
    );
    const input = documents.find(
      (document) =>
        field(document, "digest") ===
        field(reply["binding"], "executionInputDigest"),
    );
    assert.deepEqual(JSON.parse(text(input, "body")), {
      cycleId: "task-870892a40708",
      repository: "/repository",
      input: { ticket: pick },
    });
    assert.deepEqual(harness.resolved, []);
  }));

await test("CLV-362 simultaneous feed picks for an active ticket admit one run", () =>
  withHarness(async (harness) => {
    await harness.start({ workflows: [feedWorkflow(harness.registration)] });
    const replies = await Promise.all([
      call(harness, request("active-first")),
      call(harness, request("active-second")),
    ]);
    assert.deepEqual(
      replies.map((reply) => reply["code"] ?? reply["kind"]).sort(),
      ["run-admitted", "ticket-active"],
    );
    const manual = request("manual-active");
    const reply = await call(harness, {
      ...manual,
      parameters: {
        ...manual.parameters,
        source: "ticket",
        submission: { ticket: pick.id },
      },
    });
    assert.equal(reply["code"], "ticket-active");
  }));

await test("CLV-362 a stored feed source and pick replay after restart and conflict with changed text or source", () =>
  withHarness(async (harness) => {
    const workflows = [feedWorkflow(harness.registration)];
    const service = await harness.start({ workflows });
    const given = request("feed-replay");
    const first = await call(harness, given);
    assert.equal(first["kind"], "run-admitted");
    await service.close();
    const documents = queryDatabase(
      harness.stateDirectory,
      "SELECT digest, body FROM documents",
    );
    const stored = documents.find(
      (document) =>
        field(document, "digest") === field(first["binding"], "requestDigest"),
    );
    assert.deepEqual(JSON.parse(text(stored, "body")), {
      source: "feed",
      submission: { ticket: pick },
      workflowId: "develop",
    });
    await harness.start({ workflows });
    const repeated = await call(
      harness,
      request("feed-replay", { text: pick.text, id: pick.id }),
    );
    assert.equal(repeated["replayed"], true);
    assert.deepEqual(repeated["receipt"], first["receipt"]);
    assert.equal(
      (
        await call(
          harness,
          request("feed-replay", { ...pick, text: "Changed" }),
        )
      )["code"],
      "conflicting-command",
    );
    assert.equal(
      (
        await call(harness, {
          ...given,
          parameters: { ...given.parameters, source: "input" },
        })
      )["code"],
      "conflicting-command",
    );
  }));

await test("CLV-362 a feed cannot admit a ticket active in another queue", () =>
  withHarness(async (harness) => {
    const queued = feedWorkflow(harness.registration);
    await harness.start({
      workflows: [queued, { ...queued, workflowId: "triage" }],
    });
    assert.equal(
      (await call(harness, request("other-first")))["kind"],
      "run-admitted",
    );
    const given = request("other-second");
    const reply = await call(harness, {
      ...given,
      parameters: { ...given.parameters, workflowId: "triage" },
    });
    assert.equal(reply["code"], "ticket-active");
  }));

await test("CLV-362 feed picks retain the active issue check for another ticket ID", () =>
  withHarness(async (harness) => {
    await harness.start({ workflows: [feedWorkflow(harness.registration)] });
    const ticket = {
      id: "800",
      text: "# Task\n\nGitHub issue: cloving-ai/cloving-ai#800 (open)",
    };
    assert.equal(
      (await call(harness, request("issue-first", ticket)))["kind"],
      "run-admitted",
    );
    const reply = await call(
      harness,
      request("issue-alias", { ...ticket, id: "CLV-800" }),
    );
    assert.equal(reply["code"], "ticket-active");
  }));

await test("CLV-362 only a queued ticket workflow with a declared feed accepts the feed source", () =>
  withHarness(async (harness) => {
    const queued = feedWorkflow(harness.registration);
    const withoutFeed = { ...queued };
    Reflect.deleteProperty(withoutFeed, "feed");
    await harness.start({
      workflows: [
        { ...withoutFeed, workflowId: "no-feed" },
        { ...queued, workflowId: "not-queued", queue: false },
        {
          ...queued,
          workflowId: "no-ticket",
          submission: { maximumBytes: 4096, fields: { prompt: "string" } },
        },
      ],
    });
    for (const workflowId of ["no-feed", "not-queued", "no-ticket"]) {
      const given = request(workflowId);
      const reply = await call(harness, {
        ...given,
        parameters: { ...given.parameters, workflowId },
      });
      assert.equal(reply["code"], "invalid-submission", workflowId);
    }
    assert.deepEqual(
      (await call(harness, { operation: "status", parameters: {} }))["runs"],
      [],
    );
  }));

await test("CLV-362 feed text permits 65536 UTF-8 bytes independently of manual input limits", () =>
  withHarness(async (harness) => {
    await harness.start({
      workflows: [feedWorkflow(harness.registration)],
    });
    for (const [index, ticket] of [
      { id: "a".repeat(64), text: "é".repeat(32_768) },
      { id: "zero", text: "" },
    ].entries()) {
      const reply = await call(
        harness,
        request(`bounded-${String(index)}`, ticket),
      );
      assert.equal(reply["kind"], "run-admitted", JSON.stringify(reply));
    }
  }));

await test("CLV-362 malformed or oversized feed picks admit no work", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [feedWorkflow(harness.registration)],
    });
    const malformed: readonly unknown[] = [
      null,
      "800",
      [],
      {},
      { id: "800" },
      { id: 800, text: "Task" },
      { id: "800", text: 800 },
      { id: "", text: "Task" },
      { id: "a".repeat(65), text: "Task" },
      { id: "owner/800", text: "Task" },
      { id: "not an ID", text: "Task" },
      { id: "next", text: "Task" },
      { id: "800", text: "é".repeat(32_768) + "a" },
      { ...pick, extra: "undeclared" },
    ];
    for (const [index, ticket] of malformed.entries()) {
      const reply = await call(
        harness,
        request(`malformed-${String(index)}`, ticket),
      );
      assert.equal(reply["code"], "invalid-feed-result", String(index));
    }
    assert.deepEqual(
      (await call(harness, { operation: "status", parameters: {} }))["runs"],
      [],
    );
    await service.close();
    assert.deepEqual(
      queryDatabase(harness.stateDirectory, "SELECT * FROM documents"),
      [],
    );
  }));

await test("CLV-362 feed admissions use the current queue lane count", () =>
  withHarness(async (harness) => {
    let lanes = 1;
    await harness.start({
      workflows: [feedWorkflow(harness.registration)],
      queue: {
        control: () => ({
          lanes,
          failedRunIds: [],
          drain: undefined,
          error: undefined,
        }),
        change: () => Promise.resolve({ kind: "changed" }),
      },
    });
    assert.equal(
      (await call(harness, request("lane-first")))["kind"],
      "run-admitted",
    );
    const second = request("lane-second", { ...pick, id: "801" });
    assert.equal((await call(harness, second))["code"], "workflow-active");
    lanes = 2;
    assert.equal((await call(harness, second))["kind"], "run-admitted");
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(field(status["queue"], "busy"), 2);
  }));

await test("CLV-362 a feed with free workflow lanes cannot exceed the repository maximum", () =>
  withHarness(async (harness) => {
    const workflow = { ...feedWorkflow(harness.registration), admission: 16 };
    await harness.start({
      workflows: [workflow, { ...workflow, workflowId: "triage" }],
    });
    for (let index = 0; index < 16; index += 1) {
      const reply = await call(
        harness,
        request(`repository-${String(index)}`, { ...pick, id: String(index) }),
      );
      assert.equal(reply["kind"], "run-admitted");
    }
    const given = request("repository-full", { ...pick, id: "900" });
    const reply = await call(harness, {
      ...given,
      parameters: { ...given.parameters, workflowId: "triage" },
    });
    assert.equal(reply["code"], "queue-repository-full");
  }));

await test("CLV-362 the spend limit refuses a feed pick before work starts", () =>
  withHarness(async (harness) => {
    await harness.start({
      workflows: [feedWorkflow(harness.registration)],
      queueDailySpendLimitUsd: 0,
    });
    assert.equal(
      (await call(harness, request("spent")))["code"],
      "queue-spend-limit",
    );
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(status["runs"], []);
  }));

await test("CLV-362 manual ticket submissions still require the ticket command", () =>
  withHarness(async (harness) => {
    await harness.start({ workflows: [feedWorkflow(harness.registration)] });
    const given = request("manual-ticket", pick.id);
    const reply = await call(harness, {
      ...given,
      parameters: { ...given.parameters, source: "ticket" },
    });
    assert.equal(reply["code"], "ticket-source-not-configured");
    const object = request("manual-object");
    assert.equal(
      (
        await call(harness, {
          ...object,
          parameters: { ...object.parameters, source: "input" },
        })
      )["code"],
      "invalid-submission",
    );
  }));
