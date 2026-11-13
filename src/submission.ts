import { record, type Fields } from "./protocol.ts";

export const ticketIdentifier = /^[A-Za-z0-9._:-]{1,64}$/;

export type SubmissionField =
  | { readonly type: "string"; readonly optional?: boolean }
  | { readonly type: "boolean"; readonly optional?: boolean }
  | { readonly type: "ticket"; readonly optional?: boolean }
  | {
      readonly type: "integer";
      readonly optional?: boolean;
      readonly minimum?: number;
      readonly maximum?: number;
    };

export interface SubmissionContract {
  readonly maximumBytes: number;
  readonly fields: Readonly<Record<string, "string" | SubmissionField>>;
}

export function hasTicketField(
  contract: SubmissionContract | undefined,
): boolean {
  const rule = contract?.fields["ticket"];
  return rule !== undefined && rule !== "string" && rule.type === "ticket";
}

export type SubmissionCheck =
  | {
      readonly kind: "valid";
      readonly normalized: string;
      readonly submission: Fields;
    }
  | {
      readonly kind: "rejected";
      readonly code: string;
      readonly detail: string;
    };

export interface SubmissionRequest {
  readonly workflowId: string;
  readonly submission: unknown;
  readonly source: unknown;
}

function rejected(code: string, detail: string): SubmissionCheck {
  return { kind: "rejected", code, detail };
}

function sorted(fields: Fields): Fields {
  return Object.fromEntries(
    Object.keys(fields)
      .sort()
      .map((key) => [key, fields[key]]),
  );
}

function invalidField(
  contract: SubmissionContract,
  submission: Fields,
): string | undefined {
  const undeclared = Object.keys(submission).find(
    (key) => !Object.hasOwn(contract.fields, key),
  );
  if (undeclared !== undefined) return undeclared;
  return Object.entries(contract.fields).find(([key, rule]) => {
    if (rule !== "string" && rule.optional && !Object.hasOwn(submission, key))
      return false;
    return !validValue(
      rule === "string" ? { type: "string" } : rule,
      submission[key],
    );
  })?.[0];
}

function validValue(rule: SubmissionField, value: unknown): boolean {
  if (rule.type === "string" || rule.type === "ticket")
    return typeof value === "string" && value.trim().length > 0;
  if (rule.type === "boolean") return typeof value === "boolean";
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (rule.minimum === undefined || value >= rule.minimum) &&
    (rule.maximum === undefined || value <= rule.maximum)
  );
}

export function normalizedRequest(
  request: SubmissionRequest & { readonly submission: Fields },
): string {
  const { workflowId, submission, source } = request;
  const ticket = source === "feed" ? record(submission["ticket"]) : undefined;
  return JSON.stringify({
    ...(source === "feed" ? { source } : {}),
    submission: sorted(
      ticket === undefined
        ? submission
        : { ...submission, ticket: sorted(ticket) },
    ),
    workflowId,
  });
}

export function checkSubmission(
  contract: SubmissionContract,
  request: SubmissionRequest,
): SubmissionCheck {
  if (request.source === "feed") return feedSubmission(request);
  if (request.source === "prompt" && !Object.hasOwn(contract.fields, "prompt"))
    return rejected(
      "unsupported-prompt",
      "The workflow does not accept a prompt. Use --input with its fields.",
    );
  const submission = record(request.submission);
  if (submission === undefined)
    return rejected("invalid-submission", "The submission is not an object.");
  const bytes = new TextEncoder().encode(JSON.stringify(submission)).length;
  if (bytes > contract.maximumBytes)
    return rejected(
      "input-too-large",
      `The input has ${String(bytes)} bytes. The limit is ${String(contract.maximumBytes)}.`,
    );
  const field = invalidField(contract, submission);
  if (field !== undefined)
    return rejected("invalid-submission", `Field ${field} is not valid.`);
  return {
    kind: "valid",
    normalized: normalizedRequest({ ...request, submission }),
    submission,
  };
}

function validFeedPick(value: unknown): boolean {
  const ticket = record(value);
  return (
    ticket !== undefined &&
    Object.keys(ticket).length === 2 &&
    typeof ticket["id"] === "string" &&
    ticketIdentifier.test(ticket["id"]) &&
    ticket["id"] !== "next" &&
    typeof ticket["text"] === "string" &&
    new TextEncoder().encode(ticket["text"]).length <= 65_536
  );
}

function feedSubmission(request: SubmissionRequest): SubmissionCheck {
  const submission = record(request.submission);
  if (
    submission === undefined ||
    Object.keys(submission).length !== 1 ||
    !validFeedPick(submission["ticket"])
  )
    return rejected("invalid-feed-result", "The feed pick is not valid.");
  return {
    kind: "valid",
    normalized: normalizedRequest({ ...request, submission }),
    submission,
  };
}

export type CheckedResolution =
  | { readonly kind: "resolved"; readonly input: string }
  | {
      readonly kind: "rejected";
      readonly code: string;
      readonly detail: string;
    };

function inputText(input: unknown): string | undefined {
  try {
    const text: unknown = JSON.stringify(input);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

export function checkResolution(value: unknown): CheckedResolution | undefined {
  const fields = record(value);
  if (fields === undefined) return undefined;
  const { kind, code, detail } = fields;
  if (kind === "rejected" && typeof code === "string" && code.length > 0)
    return { kind, code, detail: typeof detail === "string" ? detail : code };
  if (kind !== "resolved") return undefined;
  const input = inputText(fields["input"]);
  return input === undefined ? undefined : { kind, input };
}
