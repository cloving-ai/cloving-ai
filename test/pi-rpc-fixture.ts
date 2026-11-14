import { openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  launchedProcess,
  launchMarker,
} from "../src/daemon/detached-process.ts";
import { createPiSession } from "../src/daemon/pi-session.ts";
import { resultOf, type Scene } from "./claude-worker-fixture.ts";
import type { PiSession } from "../src/daemon/pi-session.ts";
import { piEvents } from "./pi-fixture.ts";

const rpcScript = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const selected = process.argv.indexOf("--session");
const recorded = selected < 0 ? undefined : JSON.parse(readFileSync(process.argv[selected + 1], "utf8").split("\\n")[0]);
writeFileSync(fixture.processFile, JSON.stringify({processId:process.pid,parentId:process.ppid}));
const session = recorded ? { ...recorded, path: process.argv[selected + 1] } : fixture.session;
const events = fixture.events;
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let active = false;
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const lines = (pending + chunk).split("\\n");
  pending = lines.pop();
  for (const line of lines) {
    const request = JSON.parse(line);
    appendFileSync(fixture.log, line + "\\n");
    const respond = (data) => emit({type:"response", id:request.id, command:request.type, success:true, data});
    if (request.type === "get_state") {
      const respondState = () => respond({sessionFile:session.path, sessionId:fixture.foreignSession ?? session.id, isStreaming:active, isCompacting:(fixture.compacting ?? false), pendingMessageCount:0});
      const readyGate = (fixture.readyGate ?? "");
      if (!readyGate || existsSync(readyGate)) respondState();
      else {
        const ready = setInterval(() => { if (!existsSync(readyGate)) return; clearInterval(ready); respondState(); }, 10);
      }
      continue;
    }
    if (!(request.type === "steer" && (fixture.omitSteerReply ?? false))) respond({disposition:request.type === "prompt" ? "started" : "queued"});
    emit({type:"message_start", message:{role:"user", content:[{type:"text",text:request.message}]}});
    if (request.type !== "prompt") continue;
    active = true;
    for (const event of events.slice(0, -1)) emit(event);
  }
});
const timer = setInterval(() => {
  if (!active || !existsSync(fixture.gate)) return;
  clearInterval(timer);
  if ((fixture.replay ?? false)) for (const event of events.slice(1, 3)) emit(event);
  emit(events.at(-1));
  if ((fixture.truncatedTail ?? false)) process.stdout.write('{"type":"message_end"');
}, 10);
process.stdin.on("end", () => { clearInterval(timer); });
`;

export function rpcFixture(
  directory: string,
  options: {
    readonly session?: PiSession;
    readonly foreignSession?: string;
    readonly readyGate?: string;
    readonly replay?: true;
    readonly omitSteerReply?: boolean;
    readonly compacting?: boolean;
    readonly truncatedTail?: boolean;
  } = {},
) {
  const files = {
    program: join(directory, "pi-rpc.mjs"),
    log: join(directory, "rpc-input.jsonl"),
    gate: join(directory, "rpc-settle"),
    output: join(directory, "rpc-output.jsonl"),
    processFile: join(directory, "rpc-process.json"),
  };
  writeFileSync(files.log, "");
  const fixture = { ...files, ...options, events: piEvents().slice(1) };
  writeFileSync(
    files.program,
    `#!${process.execPath}\nconst fixture = ${JSON.stringify(fixture)};\n${rpcScript}`,
    { mode: 0o700 },
  );
  return { ...files, requests: () => rpcRequests(files.log) };
}

function rpcRequests(log: string): readonly Record<string, unknown>[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => resultOf(line));
}

export async function startRpcFixture(
  scene: Scene,
  options: {
    readonly prompt?: string;
    readonly foreignSession?: string;
    readonly readyGate?: string;
    readonly replay?: true;
    readonly environment?: NodeJS.ProcessEnv;
    readonly omitSteerReply?: boolean;
    readonly compacting?: boolean;
    readonly truncatedTail?: boolean;
  } = {},
) {
  const session = await createPiSession({
    folder: scene.directory,
    directory: scene.repository,
  });
  if (typeof session === "string") throw new Error(session);
  const fake = rpcFixture(scene.directory, {
    ...options,
    session: { ...session, id: options.foreignSession ?? session.id },
  });
  const files = {
    output: fake.output,
    offset: 0,
    configuration: join(scene.directory, "configuration"),
    exit: join(scene.directory, "exit.json"),
  };
  const piRpc = join(scene.directory, "rpc");
  const turn = launchedProcess({
    executable: process.execPath,
    arguments: [fake.program],
    environment: options.environment ?? process.env,
    directory: scene.repository,
    descriptors: [
      "ignore",
      openSync(fake.output, "w"),
      openSync(join(scene.directory, "error.log"), "w"),
    ],
    marker: launchMarker(scene.directory, files),
    piRpc: { folder: piRpc, session, prompt: options.prompt ?? "one prompt" },
  });
  const ending = turn.ending(new AbortController().signal);
  const launch = await turn.launch;
  if (launch === null) throw new Error("RPC launch not observed");
  return { fake, turn, ending, launch, owner: { ...launch, piRpc }, session };
}
