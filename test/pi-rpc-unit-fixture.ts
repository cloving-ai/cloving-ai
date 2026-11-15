import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { attachPiRpc, preparePiRpc } from "../src/daemon/pi-rpc-launcher.ts";
import {
  rpcNoteRequest,
  rpcWrite,
  type PiRpcOwner,
} from "../src/daemon/pi-rpc-channel.ts";
import { resultOf, type Scene } from "./claude-worker-fixture.ts";
import {
  processIdentity,
  type RecordedProcess,
} from "../src/daemon/process-identity.ts";

export async function rpcProcessUnit(scene: Scene) {
  const identity = await processIdentity(process.pid);
  if (identity === undefined) throw new Error("unit process identity missing");
  return rpcUnit(scene, {
    processId: process.pid,
    processStart: identity.start,
    marker: identity.command.split(" ")[0] ?? "",
  });
}

function queueInput(owner: PiRpcOwner, sequence: number) {
  const input = rpcNoteRequest(owner, {
    noteId: `unit-${String(sequence)}`,
    text: "note",
    sequence,
  });
  rpcWrite(join(owner.piRpc, "requests", `${input.id}.json`), input);
  return input;
}

export function rpcUnit(scene: Scene, identity?: RecordedProcess) {
  const folder = join(scene.directory, "pi-rpc");
  const start = {
    folder,
    prompt: "initial prompt",
    session: {
      path: join(scene.directory, "session.jsonl"),
      id: "unit-session",
      cwd: scene.repository,
      timestamp: "2026-11-13T00:00:00.000Z",
    },
  };
  const owner = {
    piRpc: folder,
    processId: 1,
    processStart: "unit start",
    marker: "unit owner",
    ...identity,
  };
  preparePiRpc(start, owner.marker);
  const child = { stdin: new PassThrough(), stdout: new PassThrough() };
  const commands = recordCommands(child.stdin);
  const stopped: string[] = [];
  const output = openSync(join(scene.directory, "unit-output"), "w");
  const close = attachPiRpc(child, {
    start,
    owner,
    output,
    stop: (reason) => {
      stopped.push(reason);
    },
  });
  return {
    folder,
    owner,
    child,
    commands,
    stopped,
    emit: (event: unknown) => {
      child.stdout.write(JSON.stringify(event) + "\n");
    },
    ready: (fields: Readonly<Record<string, unknown>> = {}) => {
      child.stdout.write(
        JSON.stringify(stateResponse(start.session, fields)) + "\n",
      );
    },
    queue: (sequence: number) => queueInput(owner, sequence),
    close,
    dispose: () => {
      close("stop");
      closeSync(output);
    },
  };
}

function stateResponse(
  session: { readonly id: string; readonly path: string },
  fields: Readonly<Record<string, unknown>>,
) {
  return {
    type: "response",
    id: "state",
    command: "get_state",
    success: true,
    data: {
      sessionId: session.id,
      sessionFile: session.path,
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      ...fields,
    },
  };
}

export function acknowledgeInitial(unit: ReturnType<typeof rpcUnit>): void {
  unit.emit({
    type: "response",
    id: "initial",
    command: "prompt",
    success: true,
    data: { disposition: "started" },
  });
  unit.emit({
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: "initial prompt" }],
    },
  });
}

function recordCommands(input: PassThrough): Record<string, unknown>[] {
  const commands: Record<string, unknown>[] = [];
  input.on("data", (text: Buffer) => {
    commands.push(resultOf(String(text)));
  });
  return commands;
}
