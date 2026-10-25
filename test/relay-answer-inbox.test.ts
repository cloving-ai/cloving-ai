import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { readAnswers, runInbox } from "../src/relay/answer-inbox.ts";
import { PhoneInbox } from "../src/relay/phone-inbox.ts";
import { openRelayStore } from "../src/relay/relay-store.ts";
import {
  answerBase,
  sealedAnswer,
  signedAnswer,
} from "./phone-answer-fixture.ts";
import { fixtureDaemonKeys, fixtureDevice } from "./phone-envelope-fixture.ts";
import {
  connectedFixturePhone,
  posted,
  opened,
  withRelay,
  type RelayUnderTest,
} from "./relay-check-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { withHarness } from "./service-fixture.ts";

const reading = { waitSeconds: 0, signal: new AbortController().signal };

function receiptCodes(relay: RelayUnderTest): readonly unknown[] {
  return posted(relay.server)
    .filter((item) => item.kind === "receipt")
    .map((item) => record(opened(item, relay.daemonId).fields["body"]))
    .map((body) => [body?.["code"], body?.["decisionId"]]);
}

function receiptIds(relay: RelayUnderTest): readonly unknown[] {
  return relay.server.requests
    .filter((request) => request.path === "/api/v1/relay/envelopes")
    .map((request) => {
      const envelopes: unknown = record(request.body)?.["envelopes"];
      return Array.isArray(envelopes)
        ? record(envelopes[0])?.["envelope_id"]
        : undefined;
    });
}

function validAnswer(relay: RelayUnderTest): string {
  return sealedAnswer(
    {
      daemonId: relay.daemonId,
      agreementPublicKey: fixtureDaemonKeys.agreementPublicKey,
    },
    {
      deviceId: fixtureDevice.deviceId,
      message: signedAnswer(
        { ...answerBase, daemonId: relay.daemonId },
        "answer",
      ),
    },
  );
}

await test("CLV-193 a broken answer gets answer-invalid, and an answer of an unknown device is acknowledged with no receipt", () =>
  withHarness(async (harness) => {
    await withRelay({ harness }, async (relay) => {
      await connectedFixturePhone(relay.store);
      relay.server.answer({
        answer_id: "broken",
        device_id: fixtureDevice.deviceId,
        ciphertext: "AAAA",
      });
      relay.server.answer({
        answer_id: "stranger",
        device_id: "unknown-phone",
        ciphertext: validAnswer(relay),
      });
      assert.equal(await readAnswers(relay.context, reading), true);
      assert.deepEqual(receiptCodes(relay), [["answer-invalid", null]]);
      assert.deepEqual(relay.server.acked, ["broken", "stranger"]);
      assert.equal(await relay.store.inbox.cursor(), 2);
    });
  }));

await test("CLV-193 a failed receipt post keeps the answer, and the retry posts the same receipt envelope", () =>
  withHarness(async (harness) => {
    await withRelay(
      { harness, settings: { envelopeStatuses: [500] } },
      async (relay) => {
        await connectedFixturePhone(relay.store);
        relay.server.answer({
          answer_id: "answer-1",
          device_id: fixtureDevice.deviceId,
          ciphertext: validAnswer(relay),
        });
        await readAnswers(relay.context, reading);
        assert.deepEqual(relay.server.acked, []);
        assert.equal(await relay.store.inbox.cursor(), 0);
        await readAnswers(relay.context, reading);
        assert.deepEqual(relay.server.acked, ["answer-1"]);
        const [first, second] = receiptIds(relay);
        assert.equal(typeof first, "string");
        assert.equal(second, first);
        assert.deepEqual(receiptCodes(relay).slice(-1), [
          ["answer-too-old", "run-1/review-1"],
        ]);
      },
    );
  }));

await test("CLV-193 a refused inbox request fails, no registration skips the poll, and a stopped loop ends", () =>
  withHarness(async (harness) => {
    await withRelay({ harness }, async (relay) => {
      relay.server.revoke("token-1");
      await assert.rejects(readAnswers(relay.context, reading), {
        message: /^inbox-failed: /,
      });
    });
    await withFiles({}, async (root) => {
      const phoneDirectory = join(root, "phone");
      await mkdir(phoneDirectory);
      const store = await openRelayStore(phoneDirectory);
      const context = {
        phoneDirectory,
        store,
        control: () => Promise.reject(new Error("no control")),
        now: () => Date.now(),
      };
      try {
        assert.equal(await readAnswers(context, reading), false);
        const stop = new AbortController();
        setTimeout(() => {
          stop.abort();
        }, 50);
        await runInbox(context, {
          signal: stop.signal,
          timing: { waitSeconds: 0, retryMilliseconds: 10 },
        });
        assert.equal(stop.signal.aborted, true);
      } finally {
        await store.close();
      }
    });
  }));

await test("CLV-193 a failed acknowledgement keeps the answer, and a malformed inbox item is skipped", () =>
  withHarness(async (harness) => {
    await withRelay(
      { harness, settings: { ackStatuses: [500] } },
      async (relay) => {
        await connectedFixturePhone(relay.store);
        relay.server.answer({
          answer_id: "odd",
          device_id: fixtureDevice.deviceId,
          ciphertext: 5,
        });
        relay.server.answer({
          answer_id: "answer-1",
          device_id: fixtureDevice.deviceId,
          ciphertext: validAnswer(relay),
        });
        await readAnswers(relay.context, reading);
        assert.deepEqual(relay.server.acked, []);
        assert.equal(await relay.store.inbox.cursor(), 0);
        await readAnswers(relay.context, reading);
        assert.deepEqual(relay.server.acked, ["answer-1"]);
        assert.equal(await relay.store.inbox.cursor(), 2);
      },
    );
  }));

await test("CLV-193 the inbox keeps one record for each answer and a cursor that only goes up", () => {
  const inbox = new PhoneInbox("phone");
  const work = {
    answerId: "answer-1",
    sequence: 3,
    deviceId: "phone-1",
    envelope: null,
  };
  assert.deepEqual(inbox.record(work), work);
  assert.deepEqual(inbox.record({ ...work, sequence: 9 }), work);
  inbox.complete({ answerId: "answer-1", sequence: 3 });
  inbox.complete({ answerId: "answer-0", sequence: 1 });
  assert.deepEqual([inbox.cursor, inbox.work], [3, []]);
});
