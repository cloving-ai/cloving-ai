import { record, type Fields } from "./protocol.ts";
import { artCodes } from "./theme-art.ts";
import { themeTokens, valueCodes, type TokenRule } from "./theme-tokens.ts";

const genericFonts: readonly string[] = [
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
];
const repeats: Readonly<Record<string, string>> = {
  none: "no-repeat",
  x: "repeat-x",
  y: "repeat-y",
  both: "repeat",
};

function themeData(document: Fields): Fields {
  return { ...record(record(document["$extensions"])?.["ai.cloving.theme"]) };
}

function tokenValue(document: Fields, name: string): unknown {
  let node: unknown = document;
  for (const part of name.split(".")) node = record(node)?.[part];
  return record(node)?.["$value"];
}

function colorText(value: unknown): string {
  if (typeof value === "string") return value;
  const color = { ...record(value) };
  const channels = [color["components"]].flat().map(String).join(" ");
  const alpha = color["alpha"];
  return `color(srgb ${channels}${typeof alpha === "number" ? ` / ${String(alpha)}` : ""})`;
}

function fontText(value: unknown): string {
  return [value]
    .flat()
    .filter((name) => typeof name === "string")
    .map((name) => (genericFonts.includes(name) ? name : `"${name}"`))
    .join(", ");
}

function valueText(value: unknown, rule: TokenRule): string {
  switch (rule.type) {
    case "color":
      return colorText(value);
    case "dimension":
      return `${String(record(value)?.["value"])}px`;
    case "fontFamily":
      return fontText(value);
  }
}

function tokenDeclarations(document: Fields): readonly string[] {
  return Object.entries(themeTokens).flatMap(([name, rule]) => {
    const value = tokenValue(document, name);
    return value === undefined || valueCodes(value, rule).length > 0
      ? []
      : [`--${name.replaceAll(".", "-")}: ${valueText(value, rule)};`];
  });
}

function artEntries(document: Fields): readonly (readonly [string, Fields])[] {
  return Object.entries({ ...record(themeData(document)["art"]) }).flatMap(
    ([slot, value]) =>
      artCodes({ [slot]: value }).length === 0
        ? [[slot, { ...record(value) }] as const]
        : [],
  );
}

function repeatOf(value: unknown): string {
  const repeat = typeof value === "string" ? repeats[value] : undefined;
  return repeat ?? "no-repeat";
}

function artDeclarations(theme: {
  readonly name: string;
  readonly document: Fields;
}): readonly string[] {
  return artEntries(theme.document).flatMap(([slot, art]) => [
    `--art-${slot}: url("themes/${theme.name}/${String(art["src"])}");`,
    `--art-${slot}-repeat: ${repeatOf(art["repeat"])};`,
    `--art-${slot}-rendering: ${art["pixelated"] === true ? "pixelated" : "auto"};`,
  ]);
}

export function themeClasses(document: Fields): readonly string[] {
  return artEntries(document).flatMap(([slot, art]) =>
    art["mode"] === "mask"
      ? [`art-${slot}`, `art-${slot}-mask`]
      : [`art-${slot}`],
  );
}

export function themeRule(theme: {
  readonly name: string;
  readonly document: Fields;
}): string {
  const declarations = [
    `color-scheme: ${themeData(theme.document)["colorScheme"] === "dark" ? "dark" : "light"};`,
    ...tokenDeclarations(theme.document),
    ...artDeclarations(theme),
  ];
  return `:root[data-theme="${theme.name}"] { ${declarations.join(" ")} }`;
}

export type ThemeWord =
  string | { readonly one: string; readonly other: string };

function wordOf(value: unknown): ThemeWord | undefined {
  if (typeof value === "string") return value;
  const forms = record(value);
  const one = forms?.["one"];
  const other = forms?.["other"];
  return typeof one === "string" && typeof other === "string"
    ? { one, other }
    : undefined;
}

export function themeWords(
  document: Fields,
): Readonly<Record<string, ThemeWord>> {
  return Object.fromEntries(
    Object.entries(record(themeData(document)["words"]) ?? {}).flatMap(
      ([key, value]) => {
        const word = wordOf(value);
        return word === undefined ? [] : [[key, word] as const];
      },
    ),
  );
}
