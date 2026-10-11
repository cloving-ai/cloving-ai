import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  call,
  decide,
  digestOf,
  eventually,
  field,
  later,
  noon,
  withHarness,
  text,
  waitingGate,
  fields,
  items,
} from "./service-fixture.ts";

const subject = (kind: string, commandId: string): string =>
  digestOf(`${kind} of ${commandId}?`);

await test("CLV-008 questions lists each pending decision with its identity, its revision and its allowed answers", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "question",
    });
    const listed = await call(harness, {
      operation: "questions",
      parameters: {},
    });
    const decisions = items(field(listed, "decisions"));
    assert.deepEqual(
      { ...listed, decisions: [{ ...fields(decisions[0]), openedAt: "" }] },
      {
        schemaVersion: 1,
        kind: "decision-list",
        decisions: [
          {
            decisionId: waiting.decisionId,
            label: "Q1",
            type: "question",
            runId: waiting.runId,
            gateId: "design-1",
            prompt: "question of c-1?",
            allowed: ["answer"],
            revision: 1,
            generation: 1,
            subjectDigest: subject("question", "c-1"),
            openedAt: "",
            expiresAt: null,
            context: [],
          },
        ],
      },
    );
    const other = await call(harness, {
      operation: "questions",
      parameters: { runId: "run-absent" },
    });
    assert.deepEqual(field(other, "decisions"), []);
    await service.close();
  }));

await test("CLV-008 an answer returns the committed receipt and the continuation carries the answer", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "question",
    });
    const result = await decide(harness, {
      command: "answer",
      reference: "Q1",
      text: "Use the table parser.",
      subjectDigest: subject("question", "c-1"),
    });
    assert.deepEqual(
      {
        ...result,
        receipt: {
          ...fields(field(result, "receipt")),
          recordedAt: "",
          commandDigest: "",
        },
      },
      {
        schemaVersion: 1,
        kind: "decision-recorded",
        decisionId: waiting.decisionId,
        runId: waiting.runId,
        decision: "answered",
        commandId: "c-decide",
        replayed: false,
        receipt: {
          commandId: "c-decide",
          sequence: 6,
          runId: waiting.runId,
          recordedAt: "",
          commandDigest: "",
        },
        run: { state: "running", revision: 4 },
        continuation: "admitted",
      },
    );
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    assert.deepEqual(
      [harness.sent[1]?.decision, harness.sent[1]?.answer],
      ["answered", digestOf("Use the table parser.")],
    );
    const listed = await call(harness, {
      operation: "questions",
      parameters: {},
    });
    assert.deepEqual(field(listed, "decisions"), []);
    await service.close();
  }));

for (const [command, decision] of [
  ["approve", "approved"],
  ["deny", "denied"],
] as const)
  await test(`CLV-008 the command ${command} records the decision ${decision} and admits one continuation with that decision`, () =>
    withHarness(async (harness) => {
      const service = await harness.start();
      const waiting = await waitingGate(harness, {
        service,
        commandId: "c-1",
        kind: "approval",
      });
      const result = await decide(harness, {
        command,
        reference: waiting.decisionId,
        subjectDigest: subject("approval", "c-1"),
      });
      assert.deepEqual(
        [
          field(result, "kind"),
          field(result, "decision"),
          field(result, "continuation"),
        ],
        ["decision-recorded", decision, "admitted"],
      );
      await eventually(() => (harness.sent.length === 2 ? true : undefined));
      assert.deepEqual(
        [
          harness.sent[1]?.kind,
          harness.sent[1]?.decision,
          harness.sent[1]?.answer,
        ],
        ["continue-run", decision, null],
      );
      await service.close();
    }));

await test("CLV-008 an ambiguous gate reference lists the candidates and commits no decision", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    await service.worker.openGate({
      runId: waiting.runId,
      commandId: "c-1-open-2",
      expectedRevision: 3,
      gateId: "design-2",
      kind: "approval",
      prompt: "second approval?",
      subject: digestOf("second approval?"),
    });
    const before = await call(harness, {
      operation: "events",
      parameters: { after: 0, limit: 100 },
    });
    const result = await decide(harness, {
      command: "approve",
      reference: waiting.runId,
      subjectDigest: subject("approval", "c-1"),
    });
    assert.deepEqual(
      [
        field(result, "kind"),
        field(result, "code"),
        field(result, "candidates"),
      ],
      [
        "error",
        "ambiguous-decision",
        [waiting.decisionId, `${waiting.runId}/design-2`],
      ],
    );
    assert.deepEqual(
      await call(harness, {
        operation: "events",
        parameters: { after: 0, limit: 100 },
      }),
      before,
    );
    await service.close();
  }));

await test("CLV-008 a decision with a wrong reference, type, revision, generation or subject is rejected with its code", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "question",
    });
    const good = {
      command: "answer",
      reference: waiting.runId,
      text: "yes",
      subjectDigest: subject("question", "c-1"),
    };
    const cases: readonly (readonly [
      Readonly<Record<string, unknown>>,
      string,
    ])[] = [
      [{ reference: "Q9" }, "unknown-decision"],
      [{ reference: "run-absent/design-1" }, "unknown-decision"],
      [{ command: "approve", text: undefined }, "decision-not-allowed"],
      [{ expectedRevision: 2 }, "stale-revision"],
      [{ generation: 2 }, "stale-generation"],
      [{ subjectDigest: digestOf("other") }, "subject-mismatch"],
      [{ text: "   " }, "invalid-request"],
    ];
    for (const [change, code] of cases)
      assert.deepEqual(
        field(await decide(harness, { ...good, ...change }), "code"),
        code,
        JSON.stringify(change),
      );
    const accepted = await decide(harness, good);
    assert.equal(field(accepted, "kind"), "decision-recorded");
    const repeated = await decide(harness, good);
    assert.equal(field(repeated, "replayed"), true);
    assert.deepEqual(field(repeated, "receipt"), field(accepted, "receipt"));
    assert.deepEqual(
      [
        field(await decide(harness, { ...good, text: "no" }), "code"),
        field(await decide(harness, { ...good, commandId: "c-late" }), "code"),
      ],
      ["conflicting-command", "decision-not-pending"],
    );
    await service.close();
  }));

await test("CLV-008 a gate past its deadline expires through the service, and a late answer and the expiry commit exactly one outcome", () =>
  withHarness(async (harness) => {
    let now = noon;
    const service = await harness.start({ clock: () => now });
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
      expiresAt: later,
    });
    now = later;
    const late = await decide(harness, {
      command: "approve",
      reference: waiting.decisionId,
      subjectDigest: subject("approval", "c-1"),
    });
    assert.ok(
      ["decision-expired", "decision-not-pending"].includes(text(late, "code")),
    );
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    assert.deepEqual(
      [harness.sent[1]?.kind, harness.sent[1]?.decision],
      ["continue-run", "expired"],
    );
    const events = await call(harness, {
      operation: "events",
      parameters: { after: 0, limit: 100 },
    });
    const outcomes = JSON.stringify(field(events, "events")).match(
      /"type":"gate\.(decided|expired)"/g,
    );
    assert.deepEqual(outcomes, ['"type":"gate.expired"']);
    await service.close();
  }));

await test("CLV-008 an answered gate does not expire later", () =>
  withHarness(async (harness) => {
    let now = noon;
    const service = await harness.start({ clock: () => now });
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
      expiresAt: later,
    });
    const approved = await decide(harness, {
      command: "approve",
      reference: waiting.decisionId,
      subjectDigest: subject("approval", "c-1"),
    });
    assert.equal(field(approved, "decision"), "approved");
    now = later;
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    await delay(200);
    const events = await call(harness, {
      operation: "events",
      parameters: { after: 0, limit: 100 },
    });
    assert.equal(JSON.stringify(events).includes("gate.expired"), false);
    assert.equal(harness.sent[1]?.decision, "approved");
    await service.close();
  }));
