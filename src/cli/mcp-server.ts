import packageMetadata from "#package" with { type: "json" };
import { maximumFrameBytes, record, type Fields } from "../protocol.ts";
import { mcpTools, mcpToolRequest, callMcpTool } from "./mcp-tools.ts";

const versions = ["2025-11-25", "2025-06-18", "2025-03-26"];

interface Frame {
  chunks: Buffer[];
  bytes: number;
}

function append(frame: Frame, chunk: Buffer): void {
  frame.bytes += chunk.length;
  if (frame.bytes <= maximumFrameBytes) frame.chunks.push(chunk);
  else frame.chunks = [];
}

function line(frame: Frame): string | undefined {
  return frame.bytes > maximumFrameBytes
    ? undefined
    : Buffer.concat(frame.chunks).toString("utf8");
}

async function* messages(): AsyncGenerator<string | undefined> {
  let frame: Frame = { chunks: [], bytes: 0 };
  for await (const value of process.stdin) {
    const chunk: unknown = value;
    if (!Buffer.isBuffer(chunk)) continue;
    let start = 0;
    for (
      let index = chunk.indexOf(10);
      index !== -1;
      index = chunk.indexOf(10, start)
    ) {
      append(frame, chunk.subarray(start, index));
      yield line(frame);
      frame = { chunks: [], bytes: 0 };
      start = index + 1;
    }
    append(frame, chunk.subarray(start));
  }
  if (frame.bytes > 0) yield line(frame);
}

function error(
  id: unknown,
  error: { readonly code: number; readonly message: string },
): Fields {
  return { jsonrpc: "2.0", id, error };
}

function identifier(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

type Message =
  | { readonly kind: "error"; readonly reply: Fields }
  | { readonly kind: "request"; readonly request: Fields };

function invalidMessage(
  id: unknown,
  failure: { readonly code: number; readonly message: string },
): Message {
  return { kind: "error", reply: error(id, failure) };
}

function parse(line: string | undefined): Message {
  if (line === undefined)
    return invalidMessage(null, {
      code: -32600,
      message: "Message exceeds one MiB.",
    });
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return invalidMessage(null, { code: -32700, message: "Parse error." });
  }
  const request = record(decoded);
  const id = identifier(request?.["id"]);
  if (request?.["jsonrpc"] !== "2.0" || typeof request["method"] !== "string")
    return invalidMessage(id, { code: -32600, message: "Invalid request." });
  if (Object.hasOwn(request, "id") && id === null)
    return invalidMessage(null, {
      code: -32600,
      message: "Invalid request ID.",
    });
  return { kind: "request", request };
}

function initialize(parameters: Fields): Fields {
  const version = parameters["protocolVersion"];
  return {
    protocolVersion:
      typeof version === "string" && versions.includes(version)
        ? version
        : "2025-11-25",
    capabilities: { tools: {} },
    serverInfo: { name: "cloving", version: packageMetadata.version },
  };
}

async function response(
  request: Fields,
  runtimeDirectory: string,
): Promise<Fields | undefined> {
  if (!Object.hasOwn(request, "id")) return undefined;
  const id = request["id"];
  const parameters =
    request["params"] === undefined ? {} : record(request["params"]);
  if (parameters === undefined)
    return error(id, { code: -32602, message: "Invalid parameters." });
  const method = request["method"];
  let result: Fields;
  if (method === "initialize") result = initialize(parameters);
  else if (method === "ping") result = {};
  else if (method === "tools/list") result = { tools: mcpTools };
  else if (method === "tools/call") {
    const command = mcpToolRequest(parameters);
    if (command === undefined)
      return error(id, {
        code: -32602,
        message: "Unknown tool or invalid arguments.",
      });
    result = await callMcpTool(runtimeDirectory, command);
  } else return error(id, { code: -32601, message: "Method not found." });
  return { jsonrpc: "2.0", id, result };
}

interface Call {
  cancelled: boolean;
}

interface Session {
  readonly runtimeDirectory: string;
  readonly calls: Map<unknown, Call>;
  readonly pending: Set<Promise<void>>;
}

function write(reply: Fields): void {
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}

function dispatch(message: Message, session: Session): void {
  if (message.kind === "error") {
    write(message.reply);
    return;
  }
  const { request } = message;
  if (!Object.hasOwn(request, "id")) {
    if (request["method"] === "notifications/cancelled") {
      const call = session.calls.get(record(request["params"])?.["requestId"]);
      if (call !== undefined) call.cancelled = true;
    }
    return;
  }
  const id = request["id"];
  const call: Call = { cancelled: false };
  session.calls.set(id, call);
  const pending = response(request, session.runtimeDirectory)
    .then((reply) => {
      if (!call.cancelled && reply !== undefined) write(reply);
    })
    .finally(() => {
      session.calls.delete(id);
      session.pending.delete(pending);
    });
  session.pending.add(pending);
}

export async function mcpServer(
  runtimeDirectory: string | undefined,
): Promise<number> {
  if (runtimeDirectory === undefined) {
    process.stderr.write(
      "repository-unknown: Use --repository <directory> or set CLOVING_RUNTIME_DIR.\n",
    );
    return 2;
  }
  const session: Session = {
    runtimeDirectory,
    calls: new Map(),
    pending: new Set(),
  };
  for await (const line of messages()) dispatch(parse(line), session);
  await Promise.all(session.pending);
  return 0;
}
