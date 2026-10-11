import assert from "node:assert/strict";
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { socketAddress } from "../src/broker/socket-address.ts";
import { send } from "../src/cli/client.ts";
import {
  call,
  digestOf,
  eventually,
  field,
  withHarness,
  startedRun,
  waitingGate,
  type Harness,
} from "./service-fixture.ts";

function request(operation: string, parameters: unknown): string {
  return `${JSON.stringify({ protocol: 1, operation, parameters })}\n`;
}

function halfClosed(harness: Harness, line: string): Promise<string> {
  return new Promise((settle, reject) => {
    const address = socketAddress(
      join(harness.runtimeDirectory, "control.sock"),
    );
    if (address.kind !== "address") {
      reject(new Error(address.detail));
      return;
    }
    const socket = net.connect({ path: address.path, allowHalfOpen: true });
    let received = "";
    socket.on("data", (data) => {
      received += data.toString();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      settle(received);
    });
    socket.on("connect", () => {
      socket.end(line);
    });
  });
}

function raw(harness: Harness, lines: readonly string[]): Promise<string> {
  return new Promise((settle, reject) => {
    const address = socketAddress(
      join(harness.runtimeDirectory, "control.sock"),
    );
    if (address.kind !== "address") {
      reject(new Error(address.detail));
      return;
    }
    const socket = net.connect(address.path);
    let received = "";
    socket.on("data", (data) => {
      received += data.toString();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      settle(received);
    });
    socket.on("connect", () => {
      for (const line of lines) socket.write(line);
      setTimeout(() => socket.end(), 300);
    });
  });
}

await test("CLV-008 the service keeps its socket private and refuses a runtime directory that other accounts can reach", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    assert.equal((await stat(harness.runtimeDirectory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(harness.runtimeDirectory, "control.sock"))).mode & 0o777,
      0o600,
    );
    await service.close();
    assert.deepEqual(await readdir(harness.runtimeDirectory), []);
    await chmod(harness.runtimeDirectory, 0o755);
    const refused = await harness.attempt();
    assert.deepEqual(refused, {
      kind: "refused",
      reason: "insecure-runtime-directory",
      detail: "mode 755",
    });
    assert.deepEqual(await readdir(harness.runtimeDirectory), []);
  }));

await test("CLV-008 a command with no service returns an actionable error and starts no authority", () =>
  withHarness(async (harness) => {
    const reply = await send(harness.runtimeDirectory, {
      operation: "status",
      parameters: {},
    });
    assert.deepEqual(reply, {
      kind: "error",
      error: {
        code: "service-unavailable",
        detail: `No Cloving service answers in ${harness.runtimeDirectory}. Start the service, or set CLOVING_RUNTIME_DIR to its runtime directory.`,
      },
    });
    assert.deepEqual(await readdir(harness.stateDirectory), []);
    assert.deepEqual(await readdir(harness.runtimeDirectory), []);
  }));

await test("CLV-008 the service refuses a malformed request, an unknown operation, a different protocol and a request that is too large, and changes no state", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const replies = await Promise.all([
      raw(harness, ["not json\n"]),
      raw(harness, [
        `${JSON.stringify({ protocol: 1, operation: "open-gate", parameters: {} })}\n`,
      ]),
      raw(harness, [
        `${JSON.stringify({ protocol: 2, operation: "status", parameters: {} })}\n`,
      ]),
      raw(harness, [`${"x".repeat(1_100_000)}\n`]),
      raw(harness, [
        `${JSON.stringify({ protocol: 1, operation: "status", parameters: [] })}\n`,
      ]),
      raw(harness, ["x".repeat(1_100_000)]),
    ]);
    assert.deepEqual(
      replies.map((reply) => field(field(JSON.parse(reply), "error"), "code")),
      [
        "invalid-request",
        "unknown-operation",
        "service-incompatible",
        "request-too-large",
        "invalid-request",
        "request-too-large",
      ],
    );
    const events = await call(harness, {
      operation: "events",
      parameters: { after: 0, limit: 10 },
    });
    assert.deepEqual(field(events, "events"), []);
    await service.close();
  }));

await test("CLV-008 a second service for the same directories is refused and the first service stays in use", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    await assert.rejects(
      harness.start(),
      /authority-held|service-already-running/,
    );
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(field(status, "kind"), "run-list");
    await service.close();
  }));

function protectedCommands(
  runId: string,
): readonly Readonly<Record<string, unknown>>[] {
  return [
    {
      kind: "decide-gate",
      commandId: "w-decide",
      runId: runId,
      gateId: "design-1",
      decision: "approved",
      expectedRevision: 1,
      generation: 1,
      subject: digestOf("approval of c-1?"),
    },
    {
      kind: "cancel-run",
      commandId: "w-cancel",
      runId: runId,
      expectedRevision: 3,
    },
    {
      kind: "expire-gate",
      commandId: "w-expire",
      runId: runId,
      gateId: "design-1",
    },
    {
      kind: "admit-run",
      commandId: "w-admit",
      runId: "run-x",
      workflow: "p",
    },
    {
      kind: "open-gate",
      commandId: "w-untyped",
      runId: runId,
      gateId: "design-9",
      expectedRevision: 3,
    },
  ];
}

await test("CLV-008 the worker port cannot answer a decision or submit a protected command", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const waiting = await waitingGate(harness, {
      service,
      commandId: "c-1",
      kind: "approval",
    });
    const before = await call(harness, {
      operation: "events",
      parameters: { after: 0, limit: 100 },
    });
    for (const command of protectedCommands(waiting.runId)) {
      const kind = String(command["kind"]);
      assert.deepEqual(await service.worker.submit(command), {
        kind: "rejected",
        reason: "permission-denied",
        detail: `worker cannot send ${kind === "open-gate" ? "an untyped gate" : kind}`,
      });
    }
    assert.deepEqual(
      await call(harness, {
        operation: "events",
        parameters: { after: 0, limit: 100 },
      }),
      before,
    );
    await service.close();
  }));

await test("CLV-008 a closed client connection does not drop an admitted run", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await startedRun(harness, { service, commandId: "c-1" });
    const partial = await raw(harness, [
      JSON.stringify({ protocol: 1, operation: "status" }).slice(0, 20),
    ]);
    assert.equal(partial, "");
    await raw(harness, [
      `${JSON.stringify({ protocol: 1, operation: "events", parameters: { after: 0, limit: 10, follow: true } })}\n`,
    ]);
    await delay(100);
    const status = await call(harness, {
      operation: "status",
      parameters: { runId },
    });
    assert.equal(field(field(status, "run"), "state"), "running");
    await service.close();
  }));

await test("CLV-008 a follow of the events sends each new event until the client closes", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const address = socketAddress(
      join(harness.runtimeDirectory, "control.sock"),
    );
    assert.equal(address.kind, "address");
    const socket = net.connect(address.path);
    let received = "";
    socket.on("data", (data) => {
      received += data.toString();
    });
    socket.write(
      `${JSON.stringify({ protocol: 1, operation: "events", parameters: { after: 0, limit: 100, follow: true } })}\n`,
    );
    await startedRun(harness, { service, commandId: "c-1" });
    await eventually(() =>
      received.split("\n").filter((line) => line.length > 0).length >= 3
        ? true
        : undefined,
    );
    socket.destroy();
    assert.deepEqual(
      received
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => field(field(JSON.parse(line), "event"), "type")),
      ["run.created", "step.dispatched", "run.started"],
    );
    await service.close();
  }));

await test("CLV-008 the service refuses a socket path that is too long in each form", () =>
  withHarness(async (harness) => {
    const deep = join(harness.runtimeDirectory, "d".repeat(60), "e".repeat(60));
    await mkdir(deep, { recursive: true, mode: 0o700 });
    const refused = await harness.attempt({ runtimeDirectory: deep });
    assert.equal(refused.kind, "refused");
    assert.equal(Reflect.get(refused, "reason"), "runtime-path-too-long");
    assert.deepEqual(await readdir(harness.stateDirectory), []);
  }));

const drop = { command: "drop", expectedRevision: 1, commandId: "c-drop" };
const submission = {
  workflowId: "develop",
  source: "prompt",
  submission: { prompt: "task" },
};

const inherited = [
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
  "valueOf",
];

await test("CLV-008 a request that names an inherited object property as its operation or its run command gets an error reply, and the service stays in use", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    for (const name of inherited) {
      const operation: unknown = JSON.parse(
        await raw(harness, [request(name, {})]),
      );
      assert.equal(
        field(field(operation, "error"), "code"),
        "unknown-operation",
        name,
      );
      const command = await call(harness, {
        operation: "run-command",
        parameters: {
          command: name,
          runId: "run-1",
          expectedRevision: 1,
          commandId: `c-${name}`,
        },
      });
      assert.equal(field(command, "code"), "invalid-request", name);
      const codes = [];
      for (const [operation, parameters] of [
        ["status", { runId: name }],
        ["events", { runId: name }],
        ["run-command", { ...drop, runId: name }],
        ["run", { ...submission, commandId: name }],
      ] as const)
        codes.push(
          field(await call(harness, { operation, parameters }), "code"),
        );
      assert.deepEqual(
        codes,
        ["unknown-run", "unknown-run", "invalid-request", "invalid-request"],
        name,
      );
    }
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.equal(field(status, "kind"), "run-list");
    await service.close();
  }));

await test("CLV-008 a client that ends its write side after the request gets the reply of a mutation", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const reply: unknown = JSON.parse(
      await halfClosed(
        harness,
        request("run", { ...submission, commandId: "c-1" }),
      ),
    );
    assert.equal(field(field(reply, "result"), "kind"), "run-admitted");
    assert.equal(await halfClosed(harness, "partial"), "");
    await service.close();
  }));

await test("CLV-008 a socket that refuses the peer gives the code permission-denied", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    await chmod(join(harness.runtimeDirectory, "control.sock"), 0);
    const reply = await send(harness.runtimeDirectory, {
      operation: "status",
      parameters: {},
    });
    assert.deepEqual(reply, {
      kind: "error",
      error: {
        code: "permission-denied",
        detail: `The service socket in ${harness.runtimeDirectory} refused this account.`,
      },
    });
    await service.close();
  }));
