import { record, type Fields } from "./protocol.ts";

export type TokenRule =
  | { readonly type: "color" }
  | { readonly type: "fontFamily" }
  | {
      readonly type: "dimension";
      readonly minimum: number;
      readonly maximum: number;
    };

const color = { type: "color" } as const;
const fontFamily = { type: "fontFamily" } as const;

function dimension(minimum: number, maximum: number): TokenRule {
  return { type: "dimension", minimum, maximum };
}

export const themeTokens: Readonly<Record<string, TokenRule>> = {
  "color.page": color,
  "color.surface": color,
  "color.panel": color,
  "color.ink": color,
  "color.muted": color,
  "color.line": color,
  "color.accent": color,
  "color.accent-strong": color,
  "color.on-accent": color,
  "color.warn": color,
  "color.bad": color,
  "color.code.background": color,
  "color.code.header": color,
  "color.code.text": color,
  "color.code.line": color,
  "color.code.muted": color,
  "color.state.running": color,
  "color.state.waiting": color,
  "color.state.attention": color,
  "color.state.completed": color,
  "color.state.failed": color,
  "shape.cut": dimension(0, 32),
  "shape.radius": dimension(0, 32),
  "shape.border": dimension(0, 8),
  "size.text": dimension(10, 24),
  "size.gap": dimension(0, 48),
  "font.ui": fontFamily,
  "font.heading": fontFamily,
  "font.code": fontFamily,
};

type TokenType = TokenRule["type"];

interface Walk {
  readonly path: string;
  readonly type: TokenType | undefined;
}

const hexColor = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/;
const hexMember = /^#[0-9A-Fa-f]{6}$/;
const fontName = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9])?$/;
const tokenKeys = ["$value", "$type", "$description"];
const groupKeys = ["$type", "$description"];
const colorKeys = ["colorSpace", "components", "alpha", "hex"];
const tokenTypes: readonly TokenType[] = ["color", "dimension", "fontFamily"];
const reservedName = /[.{}]/;

export function onlyKeys(fields: Fields, allowed: readonly string[]): boolean {
  return Object.keys(fields).every((key) => allowed.includes(key));
}

function isTokenType(value: unknown): value is TokenType {
  return tokenTypes.some((type) => type === value);
}

function unit(value: unknown): boolean {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function isColorObject(fields: Fields): boolean {
  const components = fields["components"];
  return (
    onlyKeys(fields, colorKeys) &&
    fields["colorSpace"] === "srgb" &&
    Array.isArray(components) &&
    components.length === 3 &&
    components.every(unit) &&
    (!Object.hasOwn(fields, "alpha") || unit(fields["alpha"])) &&
    (!Object.hasOwn(fields, "hex") ||
      (typeof fields["hex"] === "string" && hexMember.test(fields["hex"])))
  );
}

function isColor(value: unknown): boolean {
  if (typeof value === "string") return hexColor.test(value);
  const fields = record(value);
  return fields !== undefined && isColorObject(fields);
}

function isDimension(
  value: unknown,
  rule: { readonly minimum: number; readonly maximum: number },
): boolean {
  const fields = record(value);
  const size = fields?.["value"];
  return (
    fields !== undefined &&
    onlyKeys(fields, ["value", "unit"]) &&
    fields["unit"] === "px" &&
    typeof size === "number" &&
    size >= rule.minimum &&
    size <= rule.maximum
  );
}

function isFontFamily(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    value.every((name) => typeof name === "string" && fontName.test(name))
  );
}

export function valueCodes(value: unknown, rule: TokenRule): readonly string[] {
  switch (rule.type) {
    case "color":
      return isColor(value) ? [] : ["invalid-color"];
    case "dimension":
      return isDimension(value, rule) ? [] : ["invalid-dimension"];
    case "fontFamily":
      return isFontFamily(value) ? [] : ["invalid-font-family"];
  }
}

function describedOnly(fields: Fields, allowed: readonly string[]): boolean {
  const description = fields["$description"];
  return (
    onlyKeys(fields, allowed) &&
    (description === undefined || typeof description === "string")
  );
}

function tokenCodes(
  value: unknown,
  walk: Walk & { readonly rule: TokenRule },
): readonly string[] {
  const token = record(value);
  if (token === undefined || !Object.hasOwn(token, "$value"))
    return ["invalid-token"];
  if (!describedOnly(token, tokenKeys)) return ["invalid-token"];
  const declared = token["$type"];
  if (declared !== undefined && !isTokenType(declared))
    return ["invalid-token"];
  const type = declared ?? walk.type;
  if (type === undefined) return ["invalid-token"];
  if (type !== walk.rule.type) return ["token-type-mismatch"];
  return valueCodes(token["$value"], walk.rule);
}

function isGroupPath(path: string): boolean {
  return Object.keys(themeTokens).some((name) => name.startsWith(`${path}.`));
}

function memberCodes(value: unknown, walk: Walk): readonly string[] {
  const rule = Object.hasOwn(themeTokens, walk.path)
    ? themeTokens[walk.path]
    : undefined;
  if (rule !== undefined) return tokenCodes(value, { ...walk, rule });
  const group = record(value);
  if (group === undefined || Object.hasOwn(group, "$value"))
    return ["unknown-token"];
  if (!isGroupPath(walk.path)) return ["unknown-token"];
  return groupCodes(group, walk);
}

function groupCodes(group: Fields, walk: Walk): readonly string[] {
  const declared = group["$type"];
  if (declared !== undefined && !isTokenType(declared))
    return ["invalid-token"];
  const properties = Object.fromEntries(
    Object.entries(group).filter(([key]) => key.startsWith("$")),
  );
  const type = declared ?? walk.type;
  return [
    ...(describedOnly(properties, groupKeys) ? [] : ["invalid-token"]),
    ...Object.entries(group)
      .filter(([key]) => !key.startsWith("$"))
      .flatMap(([key, value]) =>
        reservedName.test(key)
          ? ["unknown-token"]
          : memberCodes(value, {
              path: walk.path === "" ? key : `${walk.path}.${key}`,
              type,
            }),
      ),
  ];
}

export function themeTokenCodes(document: Fields): readonly string[] {
  const tokens = Object.fromEntries(
    Object.entries(document).filter(([key]) => key !== "$extensions"),
  );
  return groupCodes(tokens, { path: "", type: undefined });
}
