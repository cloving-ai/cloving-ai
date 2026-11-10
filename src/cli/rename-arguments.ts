import { isRecordKey } from "../authority/commands.ts";

export interface RenameInvocation {
  readonly kind: "rename";
  readonly runId: string;
  readonly title: string | null;
  readonly label: string | null;
  readonly clear: boolean;
  readonly commandId: string | null;
  readonly json: boolean;
}

interface RenameRequest {
  readonly positionals: readonly string[];
  readonly options: readonly {
    readonly name: string;
    readonly value: string | undefined;
  }[];
}

function given(request: RenameRequest, name: string): boolean {
  return request.options.some((option) => option.name === name);
}

function valueOf(request: RenameRequest, name: string): string | null {
  return request.options.find((option) => option.name === name)?.value ?? null;
}

function refusal(request: RenameRequest): string | undefined {
  const named = given(request, "title") || given(request, "label");
  if (given(request, "clear")) return named ? "unexpected-option" : undefined;
  return given(request, "title") ? undefined : "missing-option";
}

export function renameInvocation(
  request: RenameRequest,
): RenameInvocation | string {
  const runId = request.positionals[0] ?? "";
  const commandId = valueOf(request, "command-id");
  if (!isRecordKey(runId) || (commandId !== null && !isRecordKey(commandId)))
    return "invalid-option-value";
  return (
    refusal(request) ?? {
      kind: "rename",
      runId,
      title: valueOf(request, "title"),
      label: valueOf(request, "label"),
      clear: given(request, "clear"),
      commandId,
      json: given(request, "json"),
    }
  );
}
