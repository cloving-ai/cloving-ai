import { isAbsolute } from "node:path";

export interface WorkerHookPolicy {
  readonly workspace: string;
  readonly editableFiles: readonly string[];
  readonly sourceFiles: readonly string[];
  readonly compilerConfiguration: string;
}

export type WorkerHookEvent =
  | { readonly event: "Stop"; readonly active: boolean }
  | {
      readonly event: "PreToolUse" | "PostToolUse";
      readonly tool: string;
      readonly file: string;
      readonly input: Record<string, unknown>;
    };

export function hookRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function paths(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item: unknown) =>
        typeof item === "string" &&
        item.length > 0 &&
        !isAbsolute(item) &&
        !item.split(/[\\/]/).some((part) => ["", ".", ".."].includes(part)),
    )
  );
}

export function readWorkerHookPolicy(value: unknown): WorkerHookPolicy {
  if (
    !hookRecord(value) ||
    typeof value["workspace"] !== "string" ||
    !isAbsolute(value["workspace"]) ||
    typeof value["compilerConfiguration"] !== "string" ||
    !isAbsolute(value["compilerConfiguration"]) ||
    !paths(value["editableFiles"]) ||
    !paths(value["sourceFiles"])
  )
    throw new Error("invalid-worker-hook-policy");
  return {
    workspace: value["workspace"],
    compilerConfiguration: value["compilerConfiguration"],
    editableFiles: value["editableFiles"],
    sourceFiles: value["sourceFiles"],
  };
}

export function readWorkerHookEvent(value: unknown): WorkerHookEvent {
  if (!hookRecord(value)) throw new Error("invalid-worker-hook-event");
  const event = value["hook_event_name"];
  if (event === "Stop") {
    if (typeof value["stop_hook_active"] !== "boolean")
      throw new Error("invalid-stop-hook-event");
    return { event, active: value["stop_hook_active"] };
  }
  if (event !== "PreToolUse" && event !== "PostToolUse")
    throw new Error("invalid-worker-hook-event");
  return { event, ...readEditInput(value) };
}

function readEditInput(value: Record<string, unknown>): {
  tool: string;
  file: string;
  input: Record<string, unknown>;
} {
  const tool = value["tool_name"];
  const input = value["tool_input"];
  if (
    typeof tool !== "string" ||
    !["Edit", "Write", "MultiEdit"].includes(tool) ||
    !hookRecord(input) ||
    typeof input["file_path"] !== "string" ||
    input["file_path"].length === 0
  )
    throw new Error("invalid-worker-hook-event");
  return { tool, file: input["file_path"], input };
}
