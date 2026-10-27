import project from "./project-config.schema.json" with { type: "json" };
import privateConfig from "./private-config.schema.json" with { type: "json" };
import { record } from "./protocol.ts";
import type { TurnProfiles } from "./turn-profile.ts";
import type { TokenPrices } from "./token-prices.ts";
import { isTurnCommand } from "./harness-defaults.ts";

export interface Configuration {
  readonly version: 1;
  readonly checks?: {
    readonly beforeMerge?: readonly string[];
    readonly required?: readonly string[];
  };
  readonly tickets?: {
    readonly command?: readonly string[];
    readonly nextCommand?: readonly string[];
  };
  readonly queue?: {
    readonly everySeconds?: number;
    readonly lanes?: number;
  };
  readonly harness?: {
    readonly name?: string;
    readonly turn?: readonly string[];
    readonly output?: "text";
    readonly kind?: "file" | "shell";
    readonly path?: string;
    readonly command?: readonly string[];
  };
  readonly profiles?: TurnProfiles;
  readonly fallbackModels?: readonly string[];
  readonly tokenPrices?: TokenPrices;
  readonly privateTexts?: readonly string[];
  readonly notify?: { readonly command?: readonly string[] };
  readonly watch?: {
    readonly port?: number | "off";
    readonly actions?: "on" | "off";
  };
  readonly selfUpdate?: { readonly everySeconds?: number };
  readonly github?: { readonly command?: readonly string[] };
}

interface Schema {
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly additionalProperties?: boolean | Schema;
  readonly propertyNames?: { readonly pattern: string };
  readonly items?: Schema;
  readonly required?: readonly string[];
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly maxItems?: number;
  readonly anyOf?: readonly Schema[];
}

const schemas: Readonly<Record<string, Schema>> = {
  project,
  private: privateConfig,
};

function invalid(field: string): never {
  throw new Error(`invalid-setting: ${field}`);
}

interface Checked {
  readonly schema: Schema;
  readonly field: string;
}

function text(value: unknown, { schema, field }: Checked): void {
  if (typeof value !== "string") invalid(field);
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
    invalid(field);
}

function number(value: unknown, { schema, field }: Checked): void {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  if (schema.type === "integer" && !Number.isInteger(value)) invalid(field);
  bounds(value, { schema, field });
}

function bounds(value: number, { schema, field }: Checked): void {
  if (schema.minimum !== undefined && value < schema.minimum) invalid(field);
  if (schema.maximum !== undefined && value > schema.maximum) invalid(field);
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
    invalid(field);
}

function scalar(value: unknown, checked: Checked): void {
  const { schema, field } = checked;
  if (field === "harness.turn" && !isTurnCommand(value)) invalid(field);
  if ("const" in schema && value !== schema.const) invalid(field);
  if (schema.enum !== undefined && !schema.enum.includes(value)) invalid(field);
  if (schema.type === "string") text(value, checked);
  if (schema.type === "number" || schema.type === "integer")
    number(value, checked);
}

function childSchema(name: string, { schema, field }: Checked): Schema | true {
  const properties = schema.properties ?? {};
  const child = Object.hasOwn(properties, name)
    ? properties[name]
    : schema.additionalProperties;
  if (child === false || child === undefined)
    throw new Error(`unknown-setting: ${field}`);
  if (
    schema.propertyNames !== undefined &&
    !new RegExp(schema.propertyNames.pattern).test(name)
  )
    invalid(field);
  return child;
}

function validateObject(value: unknown, { schema, field }: Checked): void {
  const object = record(value);
  if (object === undefined) invalid(field);
  for (const required of schema.required ?? [])
    if (!Object.hasOwn(object, required)) invalid(`${field}.${required}`);
  for (const [name, item] of Object.entries(object)) {
    const path = field === "" ? name : `${field}.${name}`;
    const child = childSchema(name, { schema, field: path });
    if (typeof child === "object")
      validate(item, { schema: child, field: path });
  }
}

function matches(value: unknown, schema: Schema): boolean {
  try {
    validate(value, { schema, field: "" });
    return true;
  } catch {
    return false;
  }
}

function validate(value: unknown, checked: Checked): void {
  const { schema, field } = checked;
  if (schema.anyOf !== undefined) {
    if (!schema.anyOf.some((option) => matches(value, option))) invalid(field);
    return;
  }
  scalar(value, checked);
  if (schema.type === "object") validateObject(value, checked);
  if (schema.type !== "array") return;
  if (!Array.isArray(value)) invalid(field);
  if (schema.maxItems !== undefined && value.length > schema.maxItems)
    invalid(field);
  if (schema.items === undefined) return;
  for (const [index, item] of value.entries())
    validate(item, {
      schema: schema.items,
      field: `${field}.${String(index)}`,
    });
}

function validateConfiguration(
  value: unknown,
  scope: "project" | "private",
): asserts value is Configuration {
  const object = record(value);
  if (object === undefined) invalid("$");
  if (object["version"] !== 1)
    throw new Error("unsupported-config-version: version");
  if (scope === "project") {
    for (const field of Object.keys(object))
      if (
        Object.hasOwn(privateConfig.properties, field) &&
        !Object.hasOwn(project.properties, field)
      )
        throw new Error(`private-setting-in-project-file: ${field}`);
  }
  validate(object, { schema: schemas[scope] ?? {}, field: "" });
}

export function configuration(
  value: unknown,
  scope: "project" | "private",
): Configuration {
  validateConfiguration(value, scope);
  return value;
}

export function settingScope(field: string): "project" | "private" {
  fieldSchema(field);
  const root = field.split(".")[0] ?? "";
  return Object.hasOwn(project.properties, root) ? "project" : "private";
}

function fieldSchema(field: string): Schema {
  if (!settingFields().includes(field))
    throw new Error(`unknown-setting: ${field}`);
  let schema: Schema = privateConfig;
  for (const name of field.split(".")) {
    if (schema.type !== "object") throw new Error(`unknown-setting: ${field}`);
    const child = childSchema(name, { schema, field });
    if (typeof child !== "object") throw new Error(`unknown-setting: ${field}`);
    schema = child;
  }
  return schema;
}

export function validateSetting(field: string, value: unknown): void {
  const schema = fieldSchema(field);
  if (
    schema.minimum !== undefined &&
    schema.maximum !== undefined &&
    typeof value === "number" &&
    (value < schema.minimum || value > schema.maximum)
  )
    throw new Error(
      `invalid-setting: ${field} must be from ${String(schema.minimum)} to ${String(schema.maximum)}`,
    );
  validate(value, { schema, field });
}

export function settingFields(): readonly string[] {
  return Object.entries(privateConfig.properties).flatMap(([name, schema]) => {
    if (name === "version") return [];
    return "properties" in schema
      ? Object.keys(schema.properties).map((child) => `${name}.${child}`)
      : [name];
  });
}
