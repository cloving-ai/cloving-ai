import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { stopChild } from "./stop-child.ts";
import { socketAddress } from "../src/broker/socket-address.ts";

interface Ended {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

type OnRequest = (socket: net.Socket, child: ReturnType<typeof spawn>) => void;

async function withSilentService(invocation: {
  readonly argumentsList: readonly string[];
  readonly onRequest: OnRequest;
}): Promise<Ended> {
  const runtime = await mkdtemp(join(tmpdir(), "clv-"));
  const address = socketAddress(join(runtime, "control.sock"));
  assert.equal(address.kind, "address");
  const sockets = new Set<net.Socket>();
  const requested = Promise.withResolvers<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("data", () => {
      requested.resolve(socket);
    });
  });
  await new Promise<void>((ready) => {
    server.listen(address.path, ready);
  });
  const child = spawn(
    process.execPath,
    [resolve("src/cli.ts"), ...invocation.argumentsList],
    {
      env: { ...process.env, CLOVING_RUNTIME_DIR: runtime },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (data: Buffer) => {
    output.stdout += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output.stderr += data.toString();
  });
  const limit = setTimeout(() => {
    stopChild(child).catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "Child cleanup failed";
      assert.fail(message);
    });
  }, 20000);
  try {
    invocation.onRequest(await requested.promise, child);
    const exited: readonly unknown[] = await once(child, "exit");
    return {
      code: typeof exited[0] === "number" ? exited[0] : null,
      signal: typeof exited[1] === "string" ? exited[1] : null,
      ...output,
    };
  } finally {
    clearTimeout(limit);
    await stopChild(child);
    for (const socket of sockets) socket.destroy();
    server.close();
    await rm(runtime, { recursive: true, force: true });
  }
}

const interrupt: OnRequest = (_socket, child) => {
  child.kill("SIGTERM");
};

for (const signal of ["SIGTERM", "SIGINT"] as const)
  await test(`CLV-008 a mutation that gets ${signal} before the reply exits 1 with outcome-unknown and its command ID`, async () => {
    const ended = await withSilentService({
      argumentsList: ["run", "develop", "--prompt", "task", "--json"],
      onRequest: (_socket, child) => {
        child.kill(signal);
      },
    });
    assert.deepEqual([ended.code, ended.signal, ended.stderr], [1, null, ""]);
    const shown: unknown = JSON.parse(ended.stdout);
    assert.deepEqual(
      { ...Object(shown), commandId: "", detail: "" },
      {
        schemaVersion: 1,
        kind: "error",
        code: "outcome-unknown",
        detail: "",
        commandId: "",
        runId: null,
        currentRevision: null,
      },
    );
    assert.match(
      String(Reflect.get(Object(shown), "commandId")),
      /^[0-9a-f-]{36}$/,
    );
  });

await test("CLV-008 the human form of an interrupted mutation gives the command ID one time", async () => {
  const ended = await withSilentService({
    argumentsList: ["drop", "run-1", "--expected-revision", "1"],
    onRequest: interrupt,
  });
  assert.deepEqual([ended.code, ended.stdout], [1, ""]);
  assert.match(
    ended.stderr,
    /^Command ID: ([0-9a-f-]{36})\noutcome-unknown: [^\n]+\n$/,
  );
});

await test("CLV-008 a mutation whose connection ends before the reply exits 1 with outcome-unknown and its command ID", async () => {
  const ended = await withSilentService({
    argumentsList: [
      "pause",
      "run-1",
      "--expected-revision",
      "1",
      "--command-id",
      "c-pause",
      "--json",
    ],
    onRequest: (socket) => {
      socket.destroy();
    },
  });
  assert.equal(ended.code, 1);
  assert.deepEqual(
    { ...Object(JSON.parse(ended.stdout)), detail: "" },
    {
      schemaVersion: 1,
      kind: "error",
      code: "outcome-unknown",
      detail: "",
      commandId: "c-pause",
      runId: null,
      currentRevision: null,
    },
  );
});

await test("CLV-008 a read command has no signal handler: a signal ends it with no result and no success exit", async () => {
  const ended = await withSilentService({
    argumentsList: ["status", "--json"],
    onRequest: interrupt,
  });
  assert.deepEqual(
    [ended.code, ended.signal, ended.stdout],
    [null, "SIGTERM", ""],
  );
});
