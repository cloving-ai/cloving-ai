import { isRecordKey } from "../authority/commands.ts";
import { record, type Fields, type ServiceRequest } from "../protocol.ts";
import {
  commandJson,
  readCommandReply,
  readCommandRequest,
  type ReadCommand,
} from "./command-requests.ts";

const identifier = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:/-]+$",
};
const limit = { type: "integer", minimum: 1, maximum: 500 };

function tool(name: string, properties: Readonly<Record<string, Fields>>) {
  return {
    name,
    inputSchema: { type: "object", properties, additionalProperties: false },
    annotations: { readOnlyHint: true },
  };
}

export const mcpTools = [
  tool("cloving_status", { runId: identifier, limit, after: identifier }),
  tool("cloving_questions", { runId: identifier }),
  tool("cloving_events", {
    runId: identifier,
    after: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { ...limit, maximum: 1000 },
  }),
];

function validArgument(value: unknown, schema: Fields): boolean {
  if (schema["type"] === "string")
    return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(value);
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= Number(schema["minimum"]) &&
    value <= Number(schema["maximum"])
  );
}

function validArguments(
  argumentsObject: Fields,
  schemas: Readonly<Record<string, Fields>>,
): boolean {
  for (const [name, value] of Object.entries(argumentsObject)) {
    const schema = schemas[name];
    if (schema === undefined || !validArgument(value, schema)) return false;
    if (name === "runId" && !isRecordKey(value)) return false;
  }
  return true;
}

function commandInput(
  kind: ReadCommand["kind"],
  argumentsObject: Fields,
): ReadCommand {
  const { runId, limit, after } = argumentsObject;
  return {
    kind,
    ...(typeof runId === "string" ? { runId } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
    ...(typeof after === "string" || typeof after === "number"
      ? { after }
      : {}),
  };
}

export function mcpToolRequest(parameters: Fields): ServiceRequest | undefined {
  const selected = mcpTools.find((tool) => tool.name === parameters["name"]);
  if (selected === undefined) return undefined;
  const argumentsObject =
    parameters["arguments"] === undefined
      ? {}
      : record(parameters["arguments"]);
  if (argumentsObject === undefined) return undefined;
  if (!validArguments(argumentsObject, selected.inputSchema.properties))
    return undefined;
  const kind = selected.name.slice("cloving_".length);
  if (kind !== "status" && kind !== "questions" && kind !== "events")
    return undefined;
  return readCommandRequest(commandInput(kind, argumentsObject));
}

export async function callMcpTool(
  runtimeDirectory: string,
  request: ServiceRequest,
): Promise<Fields> {
  const reply = await readCommandReply(runtimeDirectory, request);
  const structuredContent = commandJson(reply);
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    ...(reply.kind === "error" ? { isError: true } : {}),
  };
}
