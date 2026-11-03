import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

type Fields = Readonly<Record<string, unknown>>;

export interface FoundSchema {
  readonly at: string;
  readonly schema: unknown;
}

export interface CheckedValue extends FoundSchema {
  readonly value: unknown;
}

const keywords = new Set([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "oneOf",
  "$ref",
]);
const componentPrefix = "#/components/schemas/";

function isFields(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldsOf(value: unknown): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  return Object.fromEntries(Object.entries(value));
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.map((item: unknown) => item) : [];
}

const typeTests: Readonly<Record<string, (value: unknown) => boolean>> = {
  object: isFields,
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === "string",
  integer: (value) => Number.isInteger(value),
  number: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean",
  null: (value) => value === null,
};

function typesOf(type: unknown): readonly string[] {
  return typeof type === "string" ? [type] : listOf(type).map(String);
}

function validType(type: unknown): boolean {
  const names = typesOf(type);
  return (
    names.length > 0 && names.every((name) => Object.hasOwn(typeTests, name))
  );
}

function resolved(document: unknown, reference: unknown): unknown {
  if (typeof reference !== "string" || !reference.startsWith(componentPrefix))
    return undefined;
  const components = fieldsOf(fieldsOf(document)["components"]);
  const schemas = fieldsOf(components["schemas"]);
  const name = reference.slice(componentPrefix.length);
  return Object.hasOwn(schemas, name) ? schemas[name] : undefined;
}

function children(found: FoundSchema): readonly FoundSchema[] {
  const schema = fieldsOf(found.schema);
  const properties = Object.entries(fieldsOf(schema["properties"]));
  return [
    ...properties.map(([name, child]) => ({
      at: `${found.at}.${name}`,
      schema: child,
    })),
    ...("items" in schema
      ? [{ at: `${found.at}[]`, schema: schema["items"] }]
      : []),
    ...listOf(schema["oneOf"]).map((child, index) => ({
      at: `${found.at}|${String(index)}`,
      schema: child,
    })),
  ];
}

function keywordFailures(document: unknown, schema: Fields): readonly string[] {
  const checks: readonly (readonly [boolean, string])[] = [
    ["type" in schema && !validType(schema["type"]), "invalid type"],
    [
      "required" in schema &&
        !listOf(schema["required"]).every((name) => typeof name === "string"),
      "invalid required",
    ],
    [
      "properties" in schema && !isFields(schema["properties"]),
      "invalid properties",
    ],
    [
      "additionalProperties" in schema &&
        schema["additionalProperties"] !== false,
      "additionalProperties other than false",
    ],
    ["enum" in schema && listOf(schema["enum"]).length === 0, "invalid enum"],
    ["oneOf" in schema && listOf(schema["oneOf"]).length < 2, "invalid oneOf"],
    [
      "$ref" in schema && resolved(document, schema["$ref"]) === undefined,
      `unresolved $ref ${String(schema["$ref"])}`,
    ],
  ];
  return checks.filter(([failed]) => failed).map(([, failure]) => failure);
}

export function schemaFailures(
  document: unknown,
  found: FoundSchema,
): readonly string[] {
  if (!isFields(found.schema)) return [`${found.at}: not a schema`];
  const schema = fieldsOf(found.schema);
  return [
    ...Object.keys(schema)
      .filter((key) => !keywords.has(key))
      .map((key) => `${found.at}: unsupported keyword ${key}`),
    ...keywordFailures(document, schema).map(
      (failure) => `${found.at}: ${failure}`,
    ),
    ...children(found).flatMap((child) => schemaFailures(document, child)),
  ];
}

export function openObjects(found: FoundSchema): readonly string[] {
  const schema = fieldsOf(found.schema);
  const open =
    typesOf(schema["type"]).includes("object") &&
    schema["additionalProperties"] !== false;
  return [
    ...(open
      ? [`${found.at}: object schema without additionalProperties false`]
      : []),
    ...children(found).flatMap((child) => openObjects(child)),
  ];
}

function typeFailures(checked: CheckedValue): readonly string[] {
  const schema = fieldsOf(checked.schema);
  if (!("type" in schema)) return [];
  const names = typesOf(schema["type"]);
  if (names.some((name) => typeTests[name]?.(checked.value) === true))
    return [];
  return [`${checked.at}: expected type ${names.join(" or ")}`];
}

function choiceFailures(checked: CheckedValue): readonly string[] {
  const schema = fieldsOf(checked.schema);
  const same = (member: unknown): boolean =>
    isDeepStrictEqual(member, checked.value);
  return [
    ...("enum" in schema && !listOf(schema["enum"]).some(same)
      ? [`${checked.at}: value outside the enum`]
      : []),
    ...("const" in schema && !same(schema["const"])
      ? [`${checked.at}: expected ${JSON.stringify(schema["const"])}`]
      : []),
  ];
}

function referenceFailures(
  document: unknown,
  checked: CheckedValue,
): readonly string[] {
  const schema = fieldsOf(checked.schema);
  if (!("$ref" in schema)) return [];
  const target = resolved(document, schema["$ref"]);
  if (target === undefined) return [`${checked.at}: unresolved $ref`];
  return valueFailures(document, { ...checked, schema: target });
}

function oneOfFailures(
  document: unknown,
  checked: CheckedValue,
): readonly string[] {
  const schema = fieldsOf(checked.schema);
  if (!("oneOf" in schema)) return [];
  const matches = listOf(schema["oneOf"]).filter(
    (choice) =>
      valueFailures(document, { ...checked, schema: choice }).length === 0,
  ).length;
  if (matches === 1) return [];
  return [`${checked.at}: matches ${String(matches)} oneOf schemas`];
}

function objectFailures(
  document: unknown,
  checked: CheckedValue,
): readonly string[] {
  if (!isFields(checked.value)) return [];
  const schema = fieldsOf(checked.schema);
  const value = fieldsOf(checked.value);
  const properties = fieldsOf(schema["properties"]);
  return [
    ...listOf(schema["required"])
      .map(String)
      .filter((name) => !Object.hasOwn(value, name))
      .map((name) => `${checked.at}: missing property ${name}`),
    ...(schema["additionalProperties"] === false
      ? Object.keys(value)
          .filter((name) => !Object.hasOwn(properties, name))
          .map((name) => `${checked.at}: unexpected property ${name}`)
      : []),
    ...Object.entries(properties)
      .filter(([name]) => Object.hasOwn(value, name))
      .flatMap(([name, child]) =>
        valueFailures(document, {
          at: `${checked.at}.${name}`,
          schema: child,
          value: value[name],
        }),
      ),
  ];
}

function arrayFailures(
  document: unknown,
  checked: CheckedValue,
): readonly string[] {
  const schema = fieldsOf(checked.schema);
  if (!Array.isArray(checked.value) || !("items" in schema)) return [];
  return listOf(checked.value).flatMap((item, index) =>
    valueFailures(document, {
      at: `${checked.at}[${String(index)}]`,
      schema: schema["items"],
      value: item,
    }),
  );
}

export function valueFailures(
  document: unknown,
  checked: CheckedValue,
): readonly string[] {
  return [
    ...referenceFailures(document, checked),
    ...typeFailures(checked),
    ...choiceFailures(checked),
    ...oneOfFailures(document, checked),
    ...objectFailures(document, checked),
    ...arrayFailures(document, checked),
  ];
}

function operationsOf(
  document: unknown,
): readonly { readonly at: string; readonly operation: Fields }[] {
  const paths = Object.entries(fieldsOf(fieldsOf(document)["paths"]));
  return paths.flatMap(([path, item]) =>
    Object.entries(fieldsOf(item)).map(([method, operation]) => ({
      at: `${method} ${path}`,
      operation: fieldsOf(operation),
    })),
  );
}

function operationSchemas(found: {
  readonly at: string;
  readonly operation: Fields;
}): readonly FoundSchema[] {
  const parameters = listOf(found.operation["parameters"]).map(fieldsOf);
  const responses = Object.entries(fieldsOf(found.operation["responses"]));
  return [
    ...parameters.map((parameter) => ({
      at: `${found.at} ${String(parameter["name"])}`,
      schema: parameter["schema"],
    })),
    ...responses.flatMap(([status, response]) =>
      Object.entries(fieldsOf(fieldsOf(response)["content"])).map(
        ([media, content]) => ({
          at: `${found.at} ${status} ${media}`,
          schema: fieldsOf(content)["schema"],
        }),
      ),
    ),
  ];
}

export function documentSchemas(document: unknown): readonly FoundSchema[] {
  const components = fieldsOf(fieldsOf(document)["components"]);
  return [
    ...Object.entries(fieldsOf(components["schemas"])).map(
      ([name, schema]) => ({ at: `${componentPrefix}${name}`, schema }),
    ),
    ...operationsOf(document).flatMap(operationSchemas),
  ];
}

export async function contractBody(
  document: unknown,
  exchange: { readonly response: Response; readonly path: string },
): Promise<unknown> {
  const { response, path } = exchange;
  const operation = fieldsOf(fieldsOf(document)["paths"])[path];
  const responses = fieldsOf(fieldsOf(fieldsOf(operation)["get"])["responses"]);
  const status = String(response.status);
  const media = response.headers.get("content-type") ?? "";
  const content = fieldsOf(fieldsOf(responses[status])["content"]);
  assert.ok(
    Object.hasOwn(content, media),
    `GET ${path} documents no ${status} ${media} response`,
  );
  const value: unknown = await response.json();
  const schema = fieldsOf(content[media])["schema"];
  assert.deepEqual(valueFailures(document, { at: "body", schema, value }), []);
  return value;
}

export async function problemBody(
  document: unknown,
  response: Response,
): Promise<Fields> {
  assert.equal(
    response.headers.get("content-type"),
    "application/problem+json",
  );
  const value: unknown = await response.json();
  const schema = { $ref: `${componentPrefix}Problem` };
  assert.deepEqual(
    valueFailures(document, { at: "problem", schema, value }),
    [],
  );
  return fieldsOf(value);
}
