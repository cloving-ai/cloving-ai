import { record, type Fields } from "./protocol.ts";
import { artAssets, artCodes } from "./theme-art.ts";
import { onlyKeys, themeTokenCodes } from "./theme-tokens.ts";
import { isPlainText, wordCodes } from "./theme-words.ts";

export type ColorScheme = "light" | "dark";

export interface ThemeCheck {
  readonly codes: readonly string[];
  readonly title: string | null;
  readonly colorScheme: ColorScheme | null;
  readonly assets: readonly string[];
}

const extensionKey = "ai.cloving.theme";
const dataKeys = ["name", "colorScheme", "art", "words"];
const cssText =
  /url\s*\(|expression\s*\(|@import|javascript\s*:|<\s*\/?\s*[a-z!?]/i;

function themeData(document: Fields): Fields | undefined {
  return record(record(document["$extensions"])?.[extensionKey]);
}

function colorScheme(value: unknown): ColorScheme | null {
  return value === "light" || value === "dark" ? value : null;
}

function extensionCodes(document: Fields): readonly string[] {
  const extensions = Object.keys(record(document["$extensions"]) ?? {});
  return extensions.some((key) => key !== extensionKey)
    ? ["unknown-extension"]
    : [];
}

function dataCodes(data: Fields | undefined): readonly string[] {
  if (data === undefined) return ["missing-theme-data"];
  return [
    ...(onlyKeys(data, dataKeys) ? [] : ["unknown-theme-field"]),
    ...(isPlainText(data["name"]) ? [] : ["invalid-name"]),
    ...(colorScheme(data["colorScheme"]) === null
      ? ["invalid-color-scheme"]
      : []),
    ...artCodes(data["art"]),
    ...wordCodes(data["words"]),
  ];
}

function texts(value: unknown): readonly string[] {
  const found: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string") {
      found.push(item);
      continue;
    }
    const children: readonly unknown[] = Array.isArray(item)
      ? item
      : Object.values(record(item) ?? {});
    for (const child of children) pending.push(child);
  }
  return found;
}

function cssCodes(document: Fields): readonly string[] {
  return texts(document).some((text) => cssText.test(text)) ? ["css-text"] : [];
}

function sorted(codes: readonly string[]): readonly string[] {
  return [...new Set(codes)].sort();
}

export function checkedTheme(value: unknown): ThemeCheck {
  const document = record(value) ?? {};
  const data = themeData(document);
  const name = data?.["name"];
  return {
    codes: sorted([
      ...themeTokenCodes(document),
      ...extensionCodes(document),
      ...dataCodes(data),
      ...cssCodes(document),
    ]),
    title: isPlainText(name) ? name : null,
    colorScheme: colorScheme(data?.["colorScheme"]),
    assets: artAssets(data?.["art"]),
  };
}
