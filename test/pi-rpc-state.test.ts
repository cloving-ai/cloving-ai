import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { rpcRecord } from "../src/daemon/pi-rpc-channel.ts";
import { withScene } from "./claude-worker-fixture.ts";
import { rpcUnit, acknowledgeInitial } from "./pi-rpc-unit-fixture.ts";

await test("CLV-365 RPC acceptance, transport write, acknowledgment and consumption remain separate", () =>
  withScene(async (scene) => {
    const unit = rpcUnit(scene);
    try {
      unit.emit({
        type: "response",
        id: "foreign",
        command: "get_state",
        success: true,
      });
      assert.equal(unit.commands.length, 1);
      unit.ready();
      assert.equal(unit.commands.length, 2);
      acknowledgeInitial(unit);
      const input = unit.queue(1);
      await delay(40);
      unit.emit({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      unit.emit({
        type: "message_start",
        message: { role: "user", content: [{}, { text: { invalid: true } }] },
      });
      unit.emit({
        type: "response",
        id: input.id,
        command: "steer",
        success: true,
        data: { disposition: "queued" },
      });
      assert.equal(
        rpcRecord(join(unit.folder, "receipts", `${input.id}.json`))?.[
          "observed"
        ],
        undefined,
      );
      unit.emit({
        type: "message_start",
        message: { role: "user", content: [{ text: input.message }] },
      });
      unit.emit({ type: "agent_settled", aborted: false });
      assert.equal(unit.child.stdin.writableEnded, true);
      assert.equal(unit.close("exit"), undefined);
      assert.deepEqual(unit.stopped, []);
    } finally {
      unit.dispose();
    }
  }));

await test("CLV-365 RPC transport deadline refuses missing readiness and missing consumption", () =>
  withScene(async (scene) => {
    const unit = rpcUnit(scene);
    try {
      await delay(5100);
      assert.ok(unit.stopped.includes("pi-rpc-startup-timeout"));
      unit.ready();
      unit.emit({
        type: "response",
        id: "initial",
        command: "prompt",
        success: true,
        data: { disposition: "queued" },
      });
      unit.emit({ type: "agent_settled", aborted: false });
      await delay(5100);
      assert.ok(unit.stopped.includes("pi-rpc-delivery-uncertain"));
      assert.equal(unit.close("exit"), "pi-rpc-delivery-uncertain");
    } finally {
      unit.dispose();
    }
  }));

await test("CLV-365 malformed and unqualified RPC control data refuse visibly", () =>
  withScene(async (scene) => {
    const unit = rpcUnit(scene);
    try {
      unit.child.stdout.write("null\n");
      unit.child.stdout.write("invalid\n");
      assert.deepEqual(unit.stopped, [
        "pi-rpc-malformed-output",
        "pi-rpc-malformed-output",
      ]);
      unit.ready();
      unit.emit({
        type: "response",
        id: "initial",
        command: "prompt",
        success: true,
        data: { disposition: "handled" },
      });
      assert.ok(unit.stopped.includes("pi-rpc-input-unconfirmed"));
      writeFileSync(
        join(unit.folder, "requests", `note-${"a".repeat(64)}.json`),
        "{}",
      );
      await delay(40);
      assert.ok(unit.stopped.includes("pi-rpc-control-failed"));
      unit.child.stdout.write("x".repeat(1_048_577));
      assert.ok(unit.stopped.includes("pi-rpc-malformed-output"));
      assert.equal(unit.close("exit"), "pi-rpc-malformed-output");
    } finally {
      unit.dispose();
    }
  }));

await test("CLV-365 RPC rejects invalid note frames and duplicate ordering before another input", () =>
  withScene(async (scene) => {
    const unit = rpcUnit(scene);
    try {
      unit.ready();
      const input = unit.queue(2);
      await delay(50);
      unit.queue(1);
      await delay(50);
      assert.ok(unit.stopped.includes("pi-rpc-note-order-conflict"));
      writeFileSync(
        join(unit.folder, "requests", `${input.id}.json`),
        JSON.stringify({ ...input, sequence: "wrong" }),
      );
      await delay(50);
      assert.ok(unit.stopped.includes("pi-rpc-control-failed"));
      unit.child.stdin.emit("error", new Error("transport failure"));
      assert.ok(unit.stopped.includes("pi-rpc-delivery-uncertain"));
      unit.emit({
        type: "message_start",
        message: { role: "user", content: "invalid" },
      });
      assert.notEqual(unit.close("exit"), undefined);
    } finally {
      unit.dispose();
    }
  }));

await test("CLV-365 RPC note limits and unknown input shapes cannot extend the invocation", () =>
  withScene(async (scene) => {
    const unit = rpcUnit(scene);
    try {
      unit.ready();
      unit.queue(1);
      unit.queue(2);
      unit.queue(3);
      unit.queue(4);
      await delay(150);
      assert.ok(unit.stopped.includes("pi-rpc-note-order-conflict"));
      assert.equal(
        unit.commands.filter((command) => command["type"] === "steer").length,
        3,
      );
    } finally {
      unit.dispose();
    }
  }));

await test("CLV-365 uncorrelated RPC responses do not acknowledge an owned input", () =>
  withScene(async (scene) => {
    const unit = rpcUnit(scene);
    try {
      unit.ready();
      unit.emit({
        type: "response",
        id: "foreign",
        command: "prompt",
        success: true,
      });
      unit.emit({
        type: "response",
        id: "initial",
        command: "steer",
        success: true,
      });
      await delay(40);
      assert.equal(
        rpcRecord(join(unit.folder, "receipts", "initial.json"))?.[
          "acknowledged"
        ],
        undefined,
      );
    } finally {
      unit.dispose();
    }
  }));

await test("CLV-365 stopping RPC before readiness fences a delayed state reply", () =>
  withScene(async (scene) => {
    const unit = rpcUnit(scene);
    try {
      unit.close("stop");
      unit.ready();
      await delay(40);
      assert.equal(unit.commands.length, 1);
      assert.equal(
        rpcRecord(join(unit.folder, "owner.json"))?.["state"],
        "closed",
      );
    } finally {
      unit.dispose();
    }
  }));

await test("CLV-365 RPC waits for stdin backpressure before accepting another write", () =>
  withScene(async (scene) => {
    const unit = rpcUnit(scene);
    try {
      unit.child.stdin.cork();
      unit.ready();
      const input = unit.queue(1);
      await delay(40);
      assert.equal(
        rpcRecord(join(unit.folder, "receipts", `${input.id}.json`)),
        undefined,
      );
      unit.child.stdin.uncork();
      await delay(80);
      assert.equal(
        unit.commands.filter((request) => request["type"] === "steer").length,
        1,
      );
    } finally {
      unit.dispose();
    }
  }));

await test("CLV-365 settlement seals RPC intake before any unpolled note can be sent", () =>
  withScene(async (scene) => {
    const unit = rpcUnit(scene);
    try {
      unit.ready();
      acknowledgeInitial(unit);
      const input = unit.queue(1);
      unit.emit({ type: "agent_settled", aborted: false });
      await delay(50);
      assert.equal(unit.child.stdin.writableEnded, true);
      assert.equal(
        unit.commands.filter((request) => request["type"] === "steer").length,
        0,
      );
      assert.equal(
        rpcRecord(join(unit.folder, "receipts", `${input.id}.json`)),
        undefined,
      );
    } finally {
      unit.dispose();
    }
  }));

await test("CLV-365 settlement fences polling while earlier RPC acknowledgments drain", () =>
  withScene(async (scene) => {
    const unit = rpcUnit(scene);
    try {
      unit.ready();
      unit.queue(1);
      unit.emit({ type: "agent_settled", aborted: false });
      await delay(50);
      assert.equal(
        unit.commands.filter((request) => request["type"] === "steer").length,
        0,
      );
      acknowledgeInitial(unit);
      assert.equal(unit.child.stdin.writableEnded, true);
      assert.deepEqual(unit.stopped, []);
    } finally {
      unit.dispose();
    }
  }));
