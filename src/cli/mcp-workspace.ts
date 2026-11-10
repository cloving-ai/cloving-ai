import { record, type Fields } from "../protocol.ts";
import { commandJson } from "./command-requests.ts";
import { servedMcp, type McpTarget } from "./mcp-server.ts";
import type { McpCall } from "./mcp-tool.ts";
import {
  callMcpTool,
  mcpToolCall,
  mcpTools,
  type McpListing,
} from "./mcp-tools.ts";
import type { WorkspaceMember, WorkspaceRecord } from "./workspace-record.ts";
import { workspaceSummary } from "./workspace-status.ts";

const repositoriesTool: Fields = {
  name: "cloving_repositories",
  description:
    "List the repositories of the workspace with the service state, the active runs and the pending decisions of each.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

function withRepository(
  tool: McpListing,
  names: readonly string[],
): McpListing {
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        repository: { type: "string", enum: names },
      },
    },
  };
}

function toolResult(
  structuredContent: Fields,
  outcome: { readonly error: boolean },
): Fields {
  return {
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    ...(outcome.error ? { isError: true } : {}),
  };
}

async function repositories(
  members: readonly WorkspaceMember[],
): Promise<Fields> {
  const summaries = await Promise.all(members.map(workspaceSummary));
  return toolResult(
    { schemaVersion: 1, kind: "workspace-status", repositories: summaries },
    { error: summaries.some((summary) => summary.service === "down") },
  );
}

function repositoryRequired(
  members: readonly WorkspaceMember[],
  call: Extract<McpCall, { readonly kind: "mutation" }>,
): Fields {
  const names = members.map((member) => member.name).join(", ");
  return toolResult(
    commandJson(
      {
        kind: "error",
        error: {
          code: "repository-required",
          detail: `The workspace lists more than one repository. Give the repository argument: ${names}.`,
        },
      },
      { commandId: call.commandId },
    ),
    { error: true },
  );
}

async function everyRepository(
  members: readonly WorkspaceMember[],
  exchange: { readonly call: McpCall; readonly signal: AbortSignal },
): Promise<Fields> {
  const results = await Promise.all(
    members.map((member) => callMcpTool(member.runtime, exchange)),
  );
  return toolResult(
    {
      schemaVersion: 1,
      kind: "workspace-read",
      repositories: members.map((member, index) => ({
        repository: member.name,
        result: results[index]?.["structuredContent"],
      })),
    },
    { error: results.every((result) => result["isError"] === true) },
  );
}

function calledMembers(
  members: readonly WorkspaceMember[],
  repository: unknown,
): readonly WorkspaceMember[] | undefined {
  if (repository === undefined) return members;
  const named = members.filter((member) => member.name === repository);
  return named.length === 0 ? undefined : named;
}

function workspaceCall(members: readonly WorkspaceMember[]): McpTarget["call"] {
  return async (parameters, signal) => {
    const values =
      parameters["arguments"] === undefined
        ? {}
        : record(parameters["arguments"]);
    if (values === undefined) return undefined;
    const { repository, ...rest } = values;
    const called = calledMembers(members, repository);
    if (called === undefined) return undefined;
    if (parameters["name"] === repositoriesTool["name"])
      return Object.keys(values).length === 0
        ? repositories(members)
        : undefined;
    const call = mcpToolCall({ ...parameters, arguments: rest });
    if (call === undefined) return undefined;
    const [only] = called;
    if (called.length === 1 && only !== undefined)
      return callMcpTool(only.runtime, { call, signal });
    return call.kind === "mutation"
      ? repositoryRequired(members, call)
      : everyRepository(called, { call, signal });
  };
}

export function workspaceTarget(
  members: readonly WorkspaceMember[],
): McpTarget {
  const names = members.map((member) => member.name);
  return {
    tools: [
      ...mcpTools.map((tool) => withRepository(tool, names)),
      repositoriesTool,
    ],
    call: workspaceCall(members),
  };
}

export async function workspaceMcpServer(
  workspace: WorkspaceRecord | undefined,
): Promise<number> {
  if (workspace === undefined) {
    process.stderr.write(
      "workspace-not-running: Start the workspace with cloving start --workspace.\n",
    );
    return 2;
  }
  return servedMcp(workspaceTarget(workspace.members));
}
