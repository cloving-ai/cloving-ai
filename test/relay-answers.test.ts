import assert from "node:assert/strict";
import { test } from "node:test";
import { record, type ServiceRequest } from "../src/protocol.ts";
import { readAnswers } from "../src/relay/answer-inbox.ts";
import { relayControl } from "../src/relay/relay-control.ts";
import {
  answerBase,
  sealedAnswer,
  signedAnswer,
  textDigest,
  type AnswerFields,
} from "./phone-answer-fixture.ts";
import { fixtureDaemonKeys, fixtureDevice } from "./phone-envelope-fixture.ts";
import {
  checked,
  connectedFixturePhone,
  opened,
  posted,
  withRelay,
  type RelayUnderTest,
} from "./relay-check-fixture.ts";
import {
  call,
  decide,
  digestOf,
  eventually,
  field,
  waitingGate,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

const allowed = ["questions", "status", "events", "decision"];

function fullBody(relay: RelayUnderTest): Readonly<Record<string, unknown>> {
  const full = posted(relay.server).find((item) => item.kind === "full");
  assert.ok(full);
  return record(opened(full, relay.daemonId).fields["body"]) ?? {};
}

function phoneAnswer(
  relay: RelayUnderTest,
  fields: AnswerFields,
): AnswerFields {
  const body = fullBody(relay);
  return {
    ...answerBase,
    daemonId: relay.daemonId,
    decisionId: body["decisionId"],
    expectedRevision: body["revision"],
    generation: body["generation"],
    subjectDigest: body["subjectDigest"],
    promptDigest: body["promptDigest"],
    signedAt: new Date(relay.clock.now).toISOString(),
    ...fields,
  };
}

function send(
  relay: RelayUnderTest,
  answer: {
    readonly answerId: string;
    readonly fields: AnswerFields;
    readonly signer: "answer" | "approval";
  },
): void {
  relay.server.answer({
    answer_id: answer.answerId,
    device_id: fixtureDevice.deviceId,
    ciphertext: sealedAnswer(
      {
        daemonId: relay.daemonId,
        agreementPublicKey: fixtureDaemonKeys.agreementPublicKey,
      },
      {
        deviceId: fixtureDevice.deviceId,
        message: signedAnswer(answer.fields, answer.signer),
      },
    ),
  });
}

function receipts(
  relay: RelayUnderTest,
): readonly Readonly<Record<string, unknown>>[] {
  return posted(relay.server)
    .filter((item) => item.kind === "receipt")
    .map((item) => {
      assert.equal(item.push, "none");
      return record(opened(item, relay.daemonId).fields["body"]) ?? {};
    });
}

async function answered(
  harness: Harness,
  relay: RelayUnderTest,
): Promise<readonly string[]> {
  const operations: string[] = [];
  const control = relayControl(harness.runtimeDirectory);
  await readAnswers(
    {
      ...relay.context,
      control: (request: ServiceRequest) => {
        operations.push(request.operation);
        return control(request);
      },
    },
    { waitSeconds: 0, signal: new AbortController().signal },
  );
  return operations;
}

await test("CLV-193 a paired phone answers a question, the run continues, and the phone gets a receipt", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "question",
    });
    await withRelay({ harness }, async (relay) => {
      await connectedFixturePhone(relay.store);
      await checked(relay);
      send(relay, {
        answerId: "answer-1",
        fields: phoneAnswer(relay, {}),
        signer: "answer",
      });
      const operations = await answered(harness, relay);
      assert.ok(operations.every((operation) => allowed.includes(operation)));
      assert.ok(operations.includes("decision"));
      const [receipt] = receipts(relay);
      assert.deepEqual(
        [receipt?.["answerId"], receipt?.["code"], receipt?.["outcome"]],
        ["answer-1", "decision-recorded", "answered"],
      );
      assert.deepEqual(relay.server.acked, ["answer-1"]);
      await eventually(() => (harness.sent.length === 2 ? true : undefined));
      const status = await call(harness, {
        operation: "status",
        parameters: { runId: waiting.runId },
      });
      assert.deepEqual(field(field(status, "run"), "decisions"), [
        {
          decisionId: waiting.decisionId,
          decision: "answered",
          actor: `device:${fixtureDevice.deviceId}`,
        },
      ]);
      assert.deepEqual(await answered(harness, relay), []);
    });
    await service.close();
  }));

await test("CLV-193 an approval signed with the answer key is refused with approval-key-required and sends no decision", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    await waitingGate(harness, { service, commandId: "c-1", kind: "approval" });
    await withRelay({ harness }, async (relay) => {
      await connectedFixturePhone(relay.store);
      await checked(relay);
      send(relay, {
        answerId: "answer-1",
        fields: phoneAnswer(relay, {
          command: "approve",
          text: null,
          textDigest: null,
          keyClass: "answer",
        }),
        signer: "answer",
      });
      const operations = await answered(harness, relay);
      assert.ok(!operations.includes("decision"));
      assert.deepEqual(
        receipts(relay).map((receipt) => receipt["code"]),
        ["approval-key-required"],
      );
      assert.deepEqual(relay.server.acked, ["answer-1"]);
    });
    await service.close();
  }));

await test("CLV-193 the same command ID posted two times gives one decision, and the second receipt is the first receipt", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    await waitingGate(harness, { service, commandId: "c-1", kind: "approval" });
    await withRelay({ harness }, async (relay) => {
      await connectedFixturePhone(relay.store);
      await checked(relay);
      const fields = phoneAnswer(relay, {
        command: "approve",
        text: null,
        textDigest: null,
        keyClass: "approval",
      });
      send(relay, { answerId: "answer-1", fields, signer: "approval" });
      send(relay, { answerId: "answer-2", fields, signer: "approval" });
      await answered(harness, relay);
      const bodies = receipts(relay);
      assert.deepEqual(
        bodies.map((body) => body["code"]),
        ["decision-recorded", "decision-recorded"],
      );
      const [first, second] = bodies.map((body) => body["receipt"]);
      assert.deepEqual(second, first);
      assert.deepEqual(relay.server.acked, ["answer-1", "answer-2"]);
    });
    await service.close();
  }));

await test("CLV-193 an answer after a terminal answer gives decision-not-pending in the receipt", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "question",
    });
    await withRelay({ harness }, async (relay) => {
      await connectedFixturePhone(relay.store);
      await checked(relay);
      await decide(harness, {
        command: "answer",
        reference: waiting.decisionId,
        text: "From the terminal.",
        subjectDigest: digestOf("question of c-1?"),
      });
      await checked(relay);
      send(relay, {
        answerId: "answer-1",
        fields: phoneAnswer(relay, {
          text: "From the phone.",
          textDigest: textDigest("From the phone."),
        }),
        signer: "answer",
      });
      await answered(harness, relay);
      assert.deepEqual(
        receipts(relay).map((receipt) => receipt["code"]),
        ["decision-not-pending"],
      );
    });
    await service.close();
  }));
