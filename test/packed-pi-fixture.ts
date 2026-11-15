import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { testMilliseconds } from "./test-timing.ts";

export async function piCli(
  consumer: { readonly root: string; readonly env: NodeJS.ProcessEnv },
  args: readonly string[],
): Promise<Record<string, unknown>> {
  const { root, env } = consumer;
  const { stdout } = await promisify(execFile)(
    join(root, "node_modules/.bin/cloving"),
    [...args, "--json"],
    { cwd: root, env, timeout: testMilliseconds(30000) },
  );
  return object(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value));
  return value;
}

export async function waitPi<T>(
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  for (let count = 0; count < testMilliseconds(30000) / 50; count += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error("Packed Pi did not reach the expected state");
}

export async function piRequests(
  root: string,
): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(root, "pi-requests.jsonl"), "utf8").catch(
    () => "",
  );
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => object(JSON.parse(line)));
}

const fakeScript = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const root = new URL("./", import.meta.url);
if (process.argv[2] === "--version") { console.log("1.5.2"); process.exit(0); }
const selected = process.argv.indexOf("--session");
const sessionFile = process.argv[selected + 1];
const session = JSON.parse(readFileSync(sessionFile, "utf8").split("\\n")[0]);
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
const message = { role:"assistant", content:[{type:"text",text:"Packed Pi answer.\\nTicket status: complete"}],
  provider:"fixture", model:"model", api:"fixture", responseId:"response-1", timestamp:1, stopReason:"stop",
  usage:{input:100, output:20, cacheRead:40, cacheWrite:0, totalTokens:160, cost:{total:6,input:1,output:2,cacheRead:3,cacheWrite:0}} };
let prompt = "";
let settled = false;
const timer = setInterval(() => {
  if (!prompt || settled || !existsSync(new URL("release",root))) return;
  settled = true;
  emit({type:"agent_end",messages:[message],willRetry:false});
  emit({type:"agent_settled",aborted:false});
},10);
const input = createInterface({input:process.stdin});
input.on("line", line => {
  const request = JSON.parse(line);
  appendFileSync(new URL("pi-requests.jsonl",root), JSON.stringify({...request,processId:process.pid,sessionId:session.id,arguments:process.argv.slice(2)}) + "\\n");
  const data = request.type === "get_state" ? {sessionFile,sessionId:session.id,isStreaming:!!prompt,isCompacting:false,pendingMessageCount:0} : {disposition:request.type === "prompt" ? "started" : "queued"};
  emit({type:"response",id:request.id,command:request.type,success:true,data});
  if (request.type === "get_state") return;
  emit({type:"message_start",message:{role:"user",content:[{type:"text",text:request.message}]}});
  if (request.type !== "prompt") return;
  prompt = request.message;
  emit({type:"agent_start"});
  if (prompt === "Hold until dropped") emit({type:"extension_ui_request",id:"permission",method:"confirm",title:"Allow?"});
  if (prompt.includes("FAIL_WITHOUT_CREDENTIALS")) {
    emit({type:"message_end",message:{...message,stopReason:"error",errorMessage:"No API key configured",usage:undefined}});
    emit({type:"agent_settled",aborted:false});
    clearInterval(timer); input.close(); process.exitCode = 1; return;
  }
  emit({type:"message_start",message:{...message,content:[]}});
  emit({type:"message_update",assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:"Live packed text"}});
  emit({type:"message_end",message});
  appendFileSync(sessionFile,JSON.stringify({type:"message",id:"assistant",parentId:null,timestamp:new Date().toISOString(),message}) + "\\n");
});
input.on("close", () => clearInterval(timer));
`;

const workflow = `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
export async function qualifyPi(input: { cycleId: string; input: { prompt: string } }) {
  "use workflow";
  const turn = await protectedEffect({ scope:{phase:"qualify",operation:"turn",round:1}, capability:"claude",method:"run-turn:pi",target:input.cycleId,payload:input.input.prompt,units:1 });
  return { kind:turn.kind === "completed" ? "handoff_requested" : "blocked",reason:turn.kind === "completed" ? "completed" : turn.reason };
}
`;

export async function piConsumer(root: string): Promise<NodeJS.ProcessEnv> {
  const folder = join(root, ".cloving/workflows");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(root, "fake-pi.mjs"),
    `#!${process.execPath}\n${fakeScript}`,
    { mode: 0o700 },
  );
  await writeFile(join(folder, "qualify.ts"), workflow);
  await writeFile(
    join(folder, "qualify.declaration.json"),
    JSON.stringify({
      workflow: {
        workflowId: "qualify-pi",
        effectLimit: 1,
        capabilities: ["claude"],
        input: { maximumBytes: 262144, fields: { prompt: { type: "string" } } },
      },
      methods: { claude: ["run-turn:pi"] },
    }),
  );
  return {
    PATH: process.env["PATH"],
    HOME: root,
    SHELL: "/bin/zsh",
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    CLOVING_RUNTIME_DIR: join(root, "host/run"),
    CLOVING_WATCH_PORT: "0",
    CLOVING_NEXT_COMMAND: "[]",
    CLOVING_TICKET_COMMAND: "[]",
    CLOVING_CHECK_COMMAND: "[]",
    CLOVING_PI_COMMAND: JSON.stringify([
      join(root, "fake-pi.mjs"),
      "--mode",
      "json",
      "--provider",
      "command-override-provider",
      "--model",
      "override-model",
      "--thinking",
      "medium",
    ]),
    NODE_OPTIONS: "--no-strip-types",
  };
}
