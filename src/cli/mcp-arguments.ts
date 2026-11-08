import type { Fields } from "../protocol.ts";

export interface Argument {
  readonly schema: Fields;
  readonly valid: (value: unknown) => boolean;
}

export const identifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9._:/-]+$",
};

export function matching(pattern: RegExp, schema: Fields): Argument {
  return {
    schema,
    valid: (value) => typeof value === "string" && pattern.test(value),
  };
}

export function whole(range: {
  readonly minimum: number;
  readonly maximum: number;
}): Argument {
  return {
    schema: { type: "integer", ...range },
    valid: (value) =>
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= range.minimum &&
      value <= range.maximum,
  };
}
