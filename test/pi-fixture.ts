import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scene } from "./claude-worker-fixture.ts";

export const piReport = "Implemented the change.\nTicket status: complete";

export function piMessage(fields: Readonly<Record<string, unknown>> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: piReport }],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    responseId: "response-1",
    timestamp: 1,
    stopReason: "stop",
    usage: {
      input: 100,
      output: 20,
      reasoning: 5,
      cacheRead: 40,
      cacheWrite: 0,
      totalTokens: 160,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 },
    },
    ...fields,
  };
}

export function piEvents(message = piMessage()): readonly unknown[] {
  return [
    { type: "session", version: 3, id: "pi-session" },
    { type: "agent_start" },
    { type: "message_start", message: { ...message, stopReason: "pending" } },
    { type: "message_end", message },
    { type: "turn_end", message, toolResults: [] },
    { type: "agent_end", messages: [message], willRetry: false },
    { type: "agent_settled", aborted: false },
  ];
}

interface FakePiOptions {
  readonly events?: readonly unknown[];
  readonly output?: string;
  readonly resumeEvents?: readonly unknown[];
  readonly resumeGate?: string;
  readonly exitCode?: number;
  readonly gate?: string;
  readonly afterGateEvents?: readonly unknown[];
  readonly chunkBytes?: number;
}

function fixtureOutput(options: FakePiOptions): string {
  return (
    options.output ??
    (options.events ?? piEvents())
      .map((event) => JSON.stringify(event) + "\n")
      .join("")
  );
}

const piInputScript = `const rpc = parts[parts.indexOf("--mode") + 1] === "rpc";
let stdin = "";
let rpcPrompt = "";
if (rpc) {
  rpcPrompt = await new Promise((resolve) => {
    let pending = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      const lines = (pending + chunk).split("\\n");
      pending = lines.pop();
      for (const line of lines) {
        const request = JSON.parse(line);
        const data = request.type === "get_state" ? {sessionId:session.id,sessionFile:parts[selected + 1],isStreaming:false,isCompacting:false,pendingMessageCount:0} : {disposition:request.type === "prompt" ? "started" : "queued"};
        process.stdout.write(JSON.stringify({type:"response",id:request.id,command:request.type,success:true,data}) + "\\n");
        if (request.type !== "prompt") continue;
        process.stdout.write(JSON.stringify({type:"message_start",message:{role:"user",content:[{type:"text",text:request.message}]}}) + "\\n");
        resolve(request.message);
      }
    });
  });
} else {
  for await (const chunk of process.stdin) stdin += String(chunk);
}
`;

export function fakePi(
  scene: Pick<Scene, "directory">,
  options: FakePiOptions = {},
): string {
  const path = join(scene.directory, "pi");
  const output = fixtureOutput(options);
  writeFileSync(
    path,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
const parts = process.argv.slice(2);
const selected = parts.indexOf("--session");
const session = selected < 0 ? undefined : JSON.parse(readFileSync(parts[selected + 1], "utf8").split("\\n")[0]);
${piInputScript}
let prompt = rpc ? rpcPrompt : stdin.trim();
const separator = parts.indexOf("--");
if (separator >= 0) prompt += parts[separator + 1] ?? "";
const handlers = [];
for (let index = 0; index < parts.length; index++) {
  if (parts[index] !== "--extension") continue;
  const extension = await import(pathToFileURL(parts[++index]).href);
  extension.default({ on: (event, handler) => { if (event === "input") handlers.push(handler); } });
}
for (const handler of handlers) {
  const result = handler({ text: prompt, source: "interactive" });
  if (result?.action === "transform") prompt = result.text;
  if (result?.action === "handled") throw new Error("Pi input was handled without a model response");
}
appendFileSync(${JSON.stringify(join(scene.directory, "pi-prompts.jsonl"))}, JSON.stringify({ prompt, processId: process.pid, session }) + "\\n");
appendFileSync(${JSON.stringify(join(scene.directory, "turns.log"))}, JSON.stringify({ prompt, processId: process.pid, parentId: process.ppid, arguments: parts, files: [], directory: process.cwd(), environment: process.env }) + "\\n");
writeFileSync(${JSON.stringify(join(scene.directory, "observed.json"))}, JSON.stringify({ arguments: parts, stdin, prompt, directory: process.cwd(), environment: process.env, configuration: process.env.GH_CONFIG_DIR === undefined ? [] : readdirSync(process.env.GH_CONFIG_DIR) }));
const invocation = readFileSync(${JSON.stringify(join(scene.directory, "pi-prompts.jsonl"))}, "utf8").trim().split("\\n").length;
const resuming = invocation > 1 && ${JSON.stringify(options.resumeEvents !== undefined)};
const output = resuming ? ${JSON.stringify((options.resumeEvents ?? []).map((event) => JSON.stringify(event) + "\n").join(""))} : ${JSON.stringify(output)};
if (session && ${JSON.stringify(options.resumeEvents !== undefined)}) {
  for (const [index, line] of output.trim().split("\\n").entries()) {
    const event = JSON.parse(line);
    if (event.type === "message_end") appendFileSync(parts[selected + 1], JSON.stringify({type:"message", id: invocation + "-" + index, parentId:null, timestamp:new Date().toISOString(), message:event.message}) + "\\n");
  }
}
const translated = output.split("\\n").map((line) => session && line.startsWith('{"type":"session",') ? JSON.stringify(session) : line).join("\\n");
const bytes = Buffer.from(translated);
const size = ${String(options.chunkBytes ?? 4096)};
for (let offset = 0; offset < bytes.length; offset += size) {
  if (!process.stdout.write(bytes.subarray(offset, offset + size))) await new Promise((resolve) => process.stdout.once("drain", resolve));
}
const gate = resuming ? ${JSON.stringify(options.resumeGate ?? "")} : ${JSON.stringify(options.gate ?? "")};
if (gate) while (!existsSync(gate)) await delay(10);
process.stdout.write(${JSON.stringify((options.afterGateEvents ?? []).map((event) => JSON.stringify(event) + "\n").join(""))});
process.exitCode = ${String(options.exitCode ?? 0)};
`,
    { mode: 0o700 },
  );
  return path;
}
