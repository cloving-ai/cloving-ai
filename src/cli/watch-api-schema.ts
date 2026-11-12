export const text = { type: "string" };
export const nullableText = { type: ["string", "null"] };
export const integer = { type: "integer" };
export const nullableNumber = { type: ["number", "null"] };
export const flag = { type: "boolean" };

export function reference(name: string): { readonly $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

export function closed(properties: Readonly<Record<string, unknown>>) {
  return {
    type: "object",
    required: Object.keys(properties),
    properties,
    additionalProperties: false,
  };
}

export function listOf(items: unknown) {
  return { type: "array", items };
}

export function json(description: string, schema: unknown) {
  return { description, content: { "application/json": { schema } } };
}

export function problem(description: string) {
  return {
    description,
    content: { "application/problem+json": { schema: reference("Problem") } },
  };
}

export function transcriptEntrySchema(kinds: readonly string[]) {
  const schema = closed({
    position: integer,
    attempt: integer,
    kind: { type: "string", enum: kinds },
    text,
    tool: nullableText,
    callId: nullableText,
    summary: text,
    error: flag,
    omittedBytes: integer,
  });
  return {
    ...schema,
    properties: { ...schema.properties, replaceId: text, removed: flag },
  };
}

export const invalidQuery = problem(
  "A query parameter is unknown, repeated or has an invalid value.",
);
