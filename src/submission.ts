import { record, type Fields } from "./protocol.ts";

export type SubmissionField =
  | { readonly type: "string"; readonly optional?: boolean }
  | { readonly type: "boolean"; readonly optional?: boolean }
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
    return !validValue(rule, submission[key]);
  })?.[0];
}

function validValue(rule: "string" | SubmissionField, value: unknown): boolean {
  if (rule === "string" || rule.type === "string")
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
  workflowId: string,
  submission: Fields,
): string {
  return JSON.stringify({ submission: sorted(submission), workflowId });
}

export function checkSubmission(
  contract: SubmissionContract,
  request: SubmissionRequest,
): SubmissionCheck {
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
    normalized: normalizedRequest(request.workflowId, submission),
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
