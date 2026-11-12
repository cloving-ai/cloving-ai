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

export function fakePi(
  scene: Pick<Scene, "directory">,
  options: {
    readonly events?: readonly unknown[];
    readonly output?: string;
    readonly exitCode?: number;
    readonly gate?: string;
    readonly afterGateEvents?: readonly unknown[];
    readonly chunkBytes?: number;
  } = {},
): string {
  const path = join(scene.directory, "pi");
  const output =
    options.output ??
    (options.events ?? piEvents())
      .map((event) => JSON.stringify(event) + "\n")
      .join("");
  writeFileSync(
    path,
    `#!${process.execPath}
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
let stdin = "";
for await (const chunk of process.stdin) stdin += String(chunk);
const parts = process.argv.slice(2);
let prompt = stdin.trim();
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
writeFileSync(${JSON.stringify(join(scene.directory, "observed.json"))}, JSON.stringify({ arguments: parts, stdin, prompt, directory: process.cwd(), environment: process.env, configuration: process.env.GH_CONFIG_DIR === undefined ? [] : readdirSync(process.env.GH_CONFIG_DIR) }));
const bytes = Buffer.from(${JSON.stringify(output)});
const size = ${String(options.chunkBytes ?? 4096)};
for (let offset = 0; offset < bytes.length; offset += size) {
  if (!process.stdout.write(bytes.subarray(offset, offset + size))) await new Promise((resolve) => process.stdout.once("drain", resolve));
}
const gate = ${JSON.stringify(options.gate ?? "")};
if (gate) while (!existsSync(gate)) await delay(10);
process.stdout.write(${JSON.stringify((options.afterGateEvents ?? []).map((event) => JSON.stringify(event) + "\n").join(""))});
process.exitCode = ${String(options.exitCode ?? 0)};
`,
    { mode: 0o700 },
  );
  return path;
}
