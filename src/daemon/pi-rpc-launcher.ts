import type { Readable, Writable } from "node:stream";
import { mkdirSync, readdirSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { record } from "../protocol.ts";
import { rpcRecord, rpcWrite } from "./pi-rpc-channel.ts";
import type { PiSession } from "./pi-session.ts";
import type { RecordedProcess } from "./process-identity.ts";

export const piRpcLauncherModule = import.meta.url;

export interface PiRpcStart {
  readonly folder: string;
  readonly session: PiSession;
  readonly prompt: string;
}

interface RpcChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
}

interface RpcInput {
  readonly id: string;
  readonly type: "prompt" | "steer";
  readonly message: string;
  readonly marker: string;
  readonly noteId?: string;
  readonly sequence?: number;
  acknowledged?: boolean;
  observed?: boolean;
  uncertain?: boolean;
  written?: boolean;
  sentAt?: number;
}

interface RpcState {
  readonly start: PiRpcStart;
  readonly owner: RecordedProcess;
  readonly inputs: Map<string, RpcInput>;
  readonly child: RpcChild;
  readonly fail: (reason: string) => void;
  readonly output: number;
  writing: boolean;
  ready: boolean;
  closed: boolean;
  settled: boolean;
  settledAt?: number;
}

export function preparePiRpc(start: PiRpcStart, marker: string): void {
  mkdirSync(start.folder, { mode: 0o700 });
  mkdirSync(join(start.folder, "requests"), { mode: 0o700 });
  mkdirSync(join(start.folder, "receipts"), { mode: 0o700 });
  rpcWrite(join(start.folder, "plan.json"), {
    ...start,
    marker,
    protocol: "pi-1.5.2",
  });
}

function ownerState(state: RpcState, phase: string): void {
  rpcWrite(join(state.start.folder, "owner.json"), {
    ...state.owner,
    protocol: "pi-1.5.2",
    state: phase,
  });
}

function saveInput(state: RpcState, input: RpcInput): void {
  rpcWrite(join(state.start.folder, "receipts", `${input.id}.json`), input);
}

function sendInput(state: RpcState, input: RpcInput): void {
  input.sentAt = Date.now();
  state.inputs.set(input.id, input);
  saveInput(state, input);
  state.settled = false;
  state.writing = true;
  state.child.stdin.write(
    JSON.stringify({ id: input.id, type: input.type, message: input.message }) +
      "\n",
    (error) => {
      state.writing = false;
      try {
        if (error !== null && error !== undefined) {
          state.fail("pi-rpc-delivery-uncertain");
          return;
        }
        input.written = true;
        saveInput(state, input);
      } catch {
        state.fail("pi-rpc-control-failed");
      }
    },
  );
}

function validSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function claimedInput(value: unknown, marker: string): RpcInput | undefined {
  const fields = record(value);
  if (fields?.["marker"] !== marker || fields["type"] !== "steer")
    return undefined;
  const { id, message, noteId, sequence } = fields;
  if (typeof id !== "string" || !/^note-[a-f0-9]{64}$/.test(id))
    return undefined;
  if (typeof message !== "string" || typeof noteId !== "string")
    return undefined;
  if (!validSequence(sequence)) return undefined;
  return { id, message, noteId, sequence, marker, type: "steer" };
}

function pendingInputs(state: RpcState): void {
  if (!state.ready || state.closed || state.settled || state.writing) return;
  const directory = join(state.start.folder, "requests");
  const inputs = readdirSync(directory)
    .filter((name) => /^note-[a-f0-9]{64}\.json$/.test(name))
    .map((name) => {
      const input = claimedInput(
        rpcRecord(join(directory, name)),
        state.owner.marker,
      );
      if (input === undefined || name !== `${input.id}.json`)
        throw new Error("pi-rpc-input-invalid");
      return input;
    })
    .sort((first, second) => (first.sequence ?? 0) - (second.sequence ?? 0));
  for (const input of inputs) {
    if (state.inputs.has(input.id)) continue;
    const earlier = [...state.inputs.values()].filter(
      (entry) => entry.type === "steer",
    );
    if (
      earlier.length >= 3 ||
      earlier.some(
        (entry) => (entry.sequence ?? Infinity) >= (input.sequence ?? 0),
      )
    ) {
      state.fail("pi-rpc-note-order-conflict");
      return;
    }
    sendInput(state, input);
    return;
  }
}

function completedInputs(state: RpcState): boolean {
  return [...state.inputs.values()].every(
    (input) => input.acknowledged === true && input.observed === true,
  );
}

function finishIdle(state: RpcState): void {
  if (!state.settled || !completedInputs(state) || state.closed) return;
  state.closed = true;
  ownerState(state, "closed");
  state.child.stdin.end();
}

function response(state: RpcState, event: Record<string, unknown>): void {
  const input = state.inputs.get(String(event["id"]));
  if (input === undefined || event["command"] !== input.type) return;
  const disposition = record(event["data"])?.["disposition"];
  if (
    event["success"] !== true ||
    !["started", "queued"].includes(String(disposition))
  ) {
    state.fail("pi-rpc-input-unconfirmed");
    return;
  }
  input.acknowledged = true;
  saveInput(state, input);
}

function observedInput(state: RpcState, event: Record<string, unknown>): void {
  const message = record(event["message"]);
  if (message?.["role"] !== "user" || !Array.isArray(message["content"]))
    return;
  const text = message["content"]
    .map((part: unknown) =>
      typeof record(part)?.["text"] === "string"
        ? String(record(part)?.["text"])
        : "",
    )
    .join("");
  for (const input of state.inputs.values()) {
    if (input.message !== text) continue;
    input.observed = true;
    saveInput(state, input);
  }
}

function initialized(state: RpcState, event: Record<string, unknown>): void {
  if (event["id"] !== "state" || event["command"] !== "get_state") return;
  const actual = record(event["data"]);
  const session = state.start.session;
  if (
    event["success"] !== true ||
    actual?.["sessionId"] !== session.id ||
    actual["sessionFile"] !== session.path ||
    actual["isStreaming"] !== false ||
    actual["isCompacting"] !== false ||
    actual["pendingMessageCount"] !== 0
  ) {
    state.fail("pi-rpc-session-conflict");
    return;
  }
  state.ready = true;
  writeSync(
    state.output,
    JSON.stringify({
      type: "session",
      version: 3,
      id: session.id,
      cwd: session.cwd,
      timestamp: session.timestamp,
    }) + "\n",
  );
  ownerState(state, "running");
  sendInput(state, {
    id: "initial",
    type: "prompt",
    message: state.start.prompt,
    marker: state.owner.marker,
  });
}

function received(state: RpcState, line: string): void {
  if (state.closed) return;
  const event = record(JSON.parse(line));
  if (event === undefined) throw new Error("pi-rpc-malformed-output");
  if (!state.ready) initialized(state, event);
  if (event["type"] === "response") response(state, event);
  if (event["type"] === "message_start") observedInput(state, event);
  if (event["type"] === "agent_settled") {
    state.settled = true;
    state.settledAt = Date.now();
  }
  finishIdle(state);
}

function closeState(state: RpcState): void {
  state.closed = true;
  for (const input of state.inputs.values()) {
    if (input.acknowledged === true && input.observed === true) continue;
    input.uncertain = true;
    saveInput(state, input);
  }
  ownerState(state, "closed");
}

function checkDeadline(state: RpcState, startedAt: number): void {
  const cutoff = Date.now() - 5000;
  if (!state.ready && startedAt < cutoff) {
    state.fail("pi-rpc-startup-timeout");
    return;
  }
  if (state.closed) return;
  const missingReply = [...state.inputs.values()].some(
    (input) =>
      input.acknowledged !== true && (input.sentAt ?? Infinity) < cutoff,
  );
  const unsettledInput =
    state.settled &&
    (state.settledAt ?? Infinity) < cutoff &&
    !completedInputs(state);
  if (missingReply || unsettledInput) state.fail("pi-rpc-delivery-uncertain");
}

function readRpcOutput(state: RpcState): () => string {
  let pending = "";
  state.child.stdout.setEncoding("utf8");
  state.child.stdout.on("data", (chunk: string) => {
    try {
      writeSync(state.output, chunk);
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      if (Buffer.byteLength(pending) > 1_048_576)
        throw new Error("pi-rpc-record-limit");
      for (const line of lines) received(state, line);
    } catch (error) {
      state.fail(
        typeof record(error)?.["code"] === "string"
          ? "pi-rpc-control-failed"
          : "pi-rpc-malformed-output",
      );
    }
  });
  return () => pending;
}

export function attachPiRpc(
  child: RpcChild,
  context: {
    readonly start: PiRpcStart;
    readonly owner: RecordedProcess;
    readonly stop: (reason: string) => void;
    readonly output?: number;
  },
): (phase: "stop" | "exit") => string | undefined {
  const { start, owner, stop } = context;
  const state: RpcState = {
    child,
    start,
    owner,
    inputs: new Map(),
    writing: false,
    ready: false,
    closed: false,
    settled: false,
    fail: stop,
    output: context.output ?? 1,
  };
  writeFileSync(
    join(start.folder, "owner.json"),
    JSON.stringify({ ...owner, protocol: "pi-1.5.2", state: "starting" }),
    { mode: 0o600, flag: "wx" },
  );
  const startedAt = Date.now();
  const timer = setInterval(() => {
    try {
      pendingInputs(state);
      checkDeadline(state, startedAt);
    } catch {
      stop("pi-rpc-control-failed");
    }
  }, 25);
  child.stdin.on("error", () => {
    stop("pi-rpc-delivery-uncertain");
  });
  const unfinished = readRpcOutput(state);
  child.stdin.write(JSON.stringify({ type: "get_state", id: "state" }) + "\n");
  return (phase) => {
    clearInterval(timer);
    closeState(state);
    if (phase !== "exit") return undefined;
    if (unfinished() !== "") return "pi-rpc-malformed-output";
    return completedInputs(state) && state.ready
      ? undefined
      : "pi-rpc-delivery-uncertain";
  };
}
