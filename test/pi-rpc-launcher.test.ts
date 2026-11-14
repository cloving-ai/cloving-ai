import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { piStream } from "../src/daemon/pi-stream.ts";
import { resultOf } from "./claude-worker-fixture.ts";
import { attachedProcess } from "../src/daemon/detached-process.ts";
import {
  submitPiRpcNote,
  piRpcNoteReceipt,
} from "../src/daemon/pi-rpc-channel.ts";
import { alive, until, withScene } from "./claude-worker-fixture.ts";
import { startRpcFixture } from "./pi-rpc-fixture.ts";

await test("CLV-365 shared RPC launcher retains one prompt and input owner through observer release", () =>
  withScene(async (scene) => {
    const { fake, owner, launch, turn, session } = await startRpcFixture(scene);
    try {
      await until(() =>
        fake.requests().some((request) => request["type"] === "prompt"),
      );
      const note = {
        noteId: "note-1",
        sequence: 1,
        text: "change direction 🐈\u2028\u2029",
      };
      assert.equal((await submitPiRpcNote(owner, note)).status, "pending");
      for (let check = 0; check < 100; check++) {
        if ((await piRpcNoteReceipt(owner, note)).status === "observed") break;
        await delay(20);
      }
      assert.equal((await piRpcNoteReceipt(owner, note)).status, "observed");
      const release = new AbortController();
      const observation = turn.ending(release.signal);
      release.abort();
      assert.equal(await observation, "released");
      assert.equal(alive(launch.processId), true);
      const recovered = attachedProcess(launch);
      assert.equal((await submitPiRpcNote(owner, note)).status, "observed");
      assert.equal(
        fake.requests().filter((request) => request["type"] === "steer").length,
        1,
      );
      writeFileSync(fake.gate, "settle");
      const end = await recovered.ending(new AbortController().signal);
      assert.notEqual(typeof end, "string");
      assert.equal(
        fake.requests().filter((request) => request["type"] === "prompt")
          .length,
        1,
      );
      await until(() => !alive(launch.processId));
      const output = readFileSync(fake.output, "utf8");
      assert.match(output, /agent_settled/);
      const stream = piStream(session);
      for (const line of output.trimEnd().split("\n")) stream.line(line);
      const accounting = resultOf(stream.result(0));
      assert.equal(accounting["is_error"], false);
      assert.equal(accounting["total_cost_usd"], null);
      const responses = resultOf(JSON.stringify(accounting["piAccounting"]))[
        "responses"
      ];
      assert.ok(Array.isArray(responses));
      assert.equal(
        resultOf(JSON.stringify(responses[0]))["reportedEstimateUsd"],
        6,
      );
      assert.equal(accounting["num_turns"], 1);
    } finally {
      turn.signal("SIGKILL");
    }
  }));

await test("CLV-365 RPC refuses a foreign live session before sending any prompt", () =>
  withScene(async (scene) => {
    const { fake, turn, ending } = await startRpcFixture(scene, {
      foreignSession: "foreign-session",
    });
    try {
      const end = await ending;
      assert.equal(
        fake.requests().filter((request) => request["type"] === "prompt")
          .length,
        0,
      );
      assert.ok(typeof end !== "string");
      assert.equal(end.reason, "pi-rpc-session-conflict");
    } finally {
      turn.signal("SIGKILL");
    }
  }));

await test("CLV-365 a lost RPC acknowledgment becomes uncertain without resending or accepting settlement", () =>
  withScene(async (scene) => {
    const { fake, owner, turn, launch, ending } = await startRpcFixture(scene, {
      omitSteerReply: true,
    });
    try {
      await until(() =>
        fake.requests().some((request) => request["type"] === "prompt"),
      );
      const note = { noteId: "lost-reply", sequence: 1, text: "only once" };
      await submitPiRpcNote(owner, note);
      await until(() =>
        fake.requests().some((request) => request["type"] === "steer"),
      );
      assert.notEqual((await piRpcNoteReceipt(owner, note)).status, "observed");
      writeFileSync(fake.gate, "settle");
      await delay(5500);
      assert.equal(alive(launch.processId), false);
      const end = await ending;
      assert.ok(typeof end !== "string");
      assert.equal(end.reason, "pi-rpc-delivery-uncertain");
      assert.equal((await submitPiRpcNote(owner, note)).status, "uncertain");
      assert.equal(
        fake.requests().filter((request) => request["type"] === "steer").length,
        1,
      );
    } finally {
      turn.signal("SIGKILL");
    }
  }));

await test("CLV-365 corrupt receipt evidence remains uncertain and never resends input", () =>
  withScene(async (scene) => {
    const { fake, owner, turn } = await startRpcFixture(scene);
    try {
      await until(() =>
        fake.requests().some((request) => request["type"] === "prompt"),
      );
      const note = {
        noteId: "corrupt-receipt",
        sequence: 1,
        text: "retain this evidence",
      };
      await submitPiRpcNote(owner, note);
      await until(() =>
        fake.requests().some((request) => request["type"] === "steer"),
      );
      await delay(100);
      const receipt = readdirSync(join(owner.piRpc, "receipts")).find((name) =>
        name.startsWith("note-"),
      );
      assert.ok(receipt);
      for (const content of ["corrupt", "null", "[]", "42"]) {
        writeFileSync(join(owner.piRpc, "receipts", receipt), content);
        assert.equal((await submitPiRpcNote(owner, note)).status, "uncertain");
      }
      assert.equal(
        fake.requests().filter((request) => request["type"] === "steer").length,
        1,
      );
    } finally {
      turn.signal("SIGKILL");
    }
  }));

await test("CLV-365 losing the RPC journal still terminates the owned process group", () =>
  withScene(async (scene) => {
    const { fake, owner, turn, ending } = await startRpcFixture(scene);
    try {
      await until(() =>
        fake.requests().some((request) => request["type"] === "prompt"),
      );
      const prompt = fake
        .requests()
        .find((request) => request["type"] === "prompt");
      assert.ok(prompt);
      renameSync(owner.piRpc, `${owner.piRpc}-unavailable`);
      await ending;
      assert.match(
        readFileSync(join(scene.directory, "exit.json"), "utf8"),
        /pi-rpc-control-failed/,
      );
    } finally {
      turn.signal("SIGKILL");
    }
  }));

await test("CLV-365 RPC preserves and refuses a truncated frame after settlement", () =>
  withScene(async (scene) => {
    const { fake, turn, ending } = await startRpcFixture(scene, {
      truncatedTail: true,
    });
    try {
      await until(() =>
        fake.requests().some((request) => request["type"] === "prompt"),
      );
      writeFileSync(fake.gate, "settle");
      const end = await ending;
      assert.ok(typeof end !== "string");
      assert.equal(end.reason, "pi-rpc-malformed-output");
      assert.ok(
        readFileSync(fake.output, "utf8").endsWith('{"type":"message_end"'),
      );
    } finally {
      turn.signal("SIGKILL");
    }
  }));

await test("CLV-365 RPC refuses a live session that is compacting", () =>
  withScene(async (scene) => {
    const { fake, turn, ending } = await startRpcFixture(scene, {
      compacting: true,
    });
    try {
      await delay(200);
      assert.equal(
        fake.requests().filter((request) => request["type"] === "prompt")
          .length,
        0,
      );
      writeFileSync(fake.gate, "settle");
      const end = await ending;
      assert.ok(typeof end !== "string");
      assert.equal(end.reason, "pi-rpc-session-conflict");
    } finally {
      turn.signal("SIGKILL");
    }
  }));

await test("CLV-365 queued RPC notes retain their recorded order", () =>
  withScene(async (scene) => {
    const { fake, turn, owner } = await startRpcFixture(scene);
    try {
      await until(() =>
        fake.requests().some((request) => request["type"] === "prompt"),
      );
      process.kill(owner.processId, "SIGSTOP");
      await submitPiRpcNote(owner, { noteId: "a", text: "first", sequence: 1 });
      await submitPiRpcNote(owner, {
        noteId: "b",
        text: "correction",
        sequence: 2,
      });
      process.kill(owner.processId, "SIGCONT");
      await until(
        () =>
          fake.requests().filter((request) => request["type"] === "steer")
            .length === 2,
      );
      assert.deepEqual(
        fake
          .requests()
          .filter((request) => request["type"] === "steer")
          .map((request) => request["message"]),
        ["Operator note a:\n\nfirst", "Operator note b:\n\ncorrection"],
      );
    } finally {
      process.kill(owner.processId, "SIGCONT");
      turn.signal("SIGKILL");
    }
  }));

await test("CLV-365 a committed RPC request without its receipt stays uncertain after exit", () =>
  withScene(async (scene) => {
    const { fake, turn, owner, ending } = await startRpcFixture(scene);
    try {
      await until(() =>
        fake.requests().some((request) => request["type"] === "prompt"),
      );
      const note = {
        noteId: "missing-receipt",
        text: "retain uncertainty",
        sequence: 1,
      };
      await submitPiRpcNote(owner, note);
      await until(() =>
        fake.requests().some((request) => request["type"] === "steer"),
      );
      await delay(100);
      const receipt = readdirSync(join(owner.piRpc, "receipts")).find((name) =>
        name.startsWith("note-"),
      );
      assert.ok(receipt);
      unlinkSync(join(owner.piRpc, "receipts", receipt));
      writeFileSync(fake.gate, "settle");
      await ending;
      assert.equal((await submitPiRpcNote(owner, note)).status, "uncertain");
    } finally {
      turn.signal("SIGKILL");
    }
  }));

await test("CLV-365 concurrent RPC submissions, conflicting reuse and foreign owners cannot duplicate input", () =>
  withScene(async (scene) => {
    const { fake, turn, owner, ending } = await startRpcFixture(scene);
    try {
      await until(() =>
        fake.requests().some((request) => request["type"] === "prompt"),
      );
      const note = {
        noteId: "concurrent",
        text: "one instruction",
        sequence: 1,
      };
      const replies = await Promise.all([
        submitPiRpcNote(owner, note),
        submitPiRpcNote(owner, note),
      ]);
      assert.equal(
        replies.some(
          (reply) =>
            reply.status === "conflict" || reply.status === "uncertain",
        ),
        false,
      );
      await until(() =>
        fake.requests().some((request) => request["type"] === "steer"),
      );
      assert.equal(
        (await submitPiRpcNote(owner, { ...note, text: "conflicting text" }))
          .status,
        "conflict",
      );
      assert.equal(
        (await piRpcNoteReceipt(owner, { ...note, sequence: 2 })).status,
        "conflict",
      );
      writeFileSync(fake.gate, "settle");
      await ending;
      assert.equal(
        (
          await submitPiRpcNote(owner, {
            ...note,
            noteId: "later",
            sequence: 2,
          })
        ).status,
        "unavailable",
      );
      assert.equal(
        fake.requests().filter((request) => request["type"] === "steer").length,
        1,
      );
    } finally {
      turn.signal("SIGKILL");
    }
  }));

await test("CLV-365 unavailable and foreign RPC ownership never submits a note", () =>
  withScene(async (scene) => {
    const { fake, turn, owner } = await startRpcFixture(scene);
    try {
      await until(() =>
        fake.requests().some((request) => request["type"] === "prompt"),
      );
      const note = { noteId: "unsubmitted", text: "unused", sequence: 1 };
      assert.equal((await piRpcNoteReceipt(owner, note)).status, "unavailable");
      assert.equal(
        (await submitPiRpcNote({ ...owner, processStart: "foreign" }, note))
          .status,
        "conflict",
      );
      assert.equal(
        (await piRpcNoteReceipt({ ...owner, piRpc: fake.log }, note)).status,
        "uncertain",
      );
      assert.equal(
        (await submitPiRpcNote({ ...owner, piRpc: fake.log }, note)).status,
        "uncertain",
      );
      assert.equal(
        fake.requests().filter((request) => request["type"] === "steer").length,
        0,
      );
    } finally {
      turn.signal("SIGKILL");
    }
  }));
