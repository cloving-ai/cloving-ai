export const protocolVersion = 1;
export const maximumFrameBytes = 1_048_576;

export type Fields = Readonly<Record<string, unknown>>;

export interface ServiceRequest {
  readonly operation: string;
  readonly parameters: Fields;
}

export interface ServiceError extends Fields {
  readonly code: string;
  readonly detail: string;
}

export type Reply =
  | { readonly kind: "result"; readonly result: Fields }
  | { readonly kind: "error"; readonly error: ServiceError };

export type ParsedRequest =
  | { readonly kind: "request"; readonly request: ServiceRequest }
  | { readonly kind: "error"; readonly error: ServiceError };

export type ReplyLine =
  Reply | { readonly kind: "event"; readonly event: Fields };

export function record(value: unknown): Fields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return Object.fromEntries(Object.entries(value));
}

function decoded(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function invalid(detail: string): ParsedRequest {
  return { kind: "error", error: { code: "invalid-request", detail } };
}

export function parseRequest(line: string): ParsedRequest {
  const fields = record(decoded(line));
  if (fields === undefined) return invalid("The request is not a JSON object.");
  if (fields["protocol"] !== protocolVersion)
    return {
      kind: "error",
      error: {
        code: "service-incompatible",
        detail: `The service uses protocol ${String(protocolVersion)}.`,
      },
    };
  const { operation } = fields;
  const parameters = record(fields["parameters"]);
  if (typeof operation !== "string" || parameters === undefined)
    return invalid("The request needs an operation and a parameters object.");
  return { kind: "request", request: { operation, parameters } };
}

export function requestLine(request: ServiceRequest): string {
  return `${JSON.stringify({ protocol: protocolVersion, ...request })}\n`;
}

export function replyLine(reply: Reply): string {
  return reply.kind === "result"
    ? `${JSON.stringify({ ok: true, result: reply.result })}\n`
    : `${JSON.stringify({ ok: false, error: reply.error })}\n`;
}

export function eventLine(event: Fields): string {
  return `${JSON.stringify({ event })}\n`;
}

export function parseReplyLine(line: string): ReplyLine | undefined {
  const fields = record(decoded(line));
  if (fields === undefined) return undefined;
  const event = record(fields["event"]);
  if (event !== undefined) return { kind: "event", event };
  const result = record(fields["result"]);
  if (fields["ok"] === true && result !== undefined)
    return { kind: "result", result };
  const error = record(fields["error"]);
  const code = error?.["code"];
  const detail = error?.["detail"];
  if (typeof code !== "string" || typeof detail !== "string") return undefined;
  return { kind: "error", error: { ...error, code, detail } };
}
