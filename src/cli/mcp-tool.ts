import { isRecordKey } from "../authority/commands.ts";
import type { Fields, ServiceRequest } from "../protocol.ts";

export interface Argument {
  readonly schema: Fields;
  readonly valid: (value: unknown) => boolean;
}

export type McpCall =
  | { readonly kind: "read"; readonly request: ServiceRequest }
  | {
      readonly kind: "mutation";
      readonly request: ServiceRequest;
      readonly commandId: string;
    };

export interface Tool {
  readonly name: string;
  readonly description?: string;
  readonly arguments: Readonly<Record<string, Argument>>;
  readonly required: readonly string[];
  readonly annotations: Fields;
  readonly call: (values: Fields) => McpCall | undefined;
}

export const identifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:/-]+$",
};

export const key: Argument = { schema: identifierSchema, valid: isRecordKey };

export const mutation = { readOnlyHint: false, idempotentHint: true };

export const repeat = "If the reply is lost, send the same commandId again.";

export function mutationCall(
  values: Fields,
  request: (commandId: string) => ServiceRequest,
): McpCall {
  const commandId = String(values["commandId"]);
  return { kind: "mutation", commandId, request: request(commandId) };
}
