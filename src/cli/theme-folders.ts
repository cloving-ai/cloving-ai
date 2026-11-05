import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configurationRoot } from "../project-settings.ts";
import { record, type Fields } from "../protocol.ts";
import { assetCodes, assetSizeCodes } from "../theme-assets.ts";
import { checkedTheme, type ColorScheme } from "../theme-check.ts";

export type ThemePlace = "project" | "user" | "built-in";

export interface ThemeFolders {
  readonly project: string;
  readonly user: string;
  readonly builtIn: string;
}

export interface ThemeEntry {
  readonly name: string;
  readonly place: ThemePlace;
  readonly title: string | null;
  readonly colorScheme: ColorScheme | null;
  readonly usable: boolean;
  readonly codes: readonly string[];
  readonly replaces: readonly ThemePlace[];
}

interface FoundTheme {
  readonly name: string;
  readonly place: ThemePlace;
}

interface ThemeDocument {
  readonly codes: readonly string[];
  readonly value?: unknown;
}

export interface LoadedTheme {
  readonly entry: ThemeEntry;
  readonly folder: string;
  readonly document: Fields;
  readonly assets: readonly string[];
}

type AssetFile =
  { readonly codes: readonly string[] } | { readonly bytes: Uint8Array };

export const themeName = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const themeFileLimit = 262_144;

export function themeFolders(input: {
  readonly repository: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): ThemeFolders {
  return {
    project: join(input.repository, ".cloving", "themes"),
    user: join(
      configurationRoot(input.environment, homedir()),
      "cloving",
      "themes",
    ),
    builtIn: fileURLToPath(new URL("themes", import.meta.resolve("#package"))),
  };
}

type Failure = "missing" | "unreadable";
type Located<Found> = Found | { readonly failure: Failure };

function absentCode(error: unknown): boolean {
  const code = record(error)?.["code"];
  return code === "ENOENT" || code === "ENOTDIR";
}

function failed(error: unknown): { readonly failure: Failure } {
  return { failure: absentCode(error) ? "missing" : "unreadable" };
}

function failureCode(failure: Failure, missing: string): string {
  return failure === "missing" ? missing : "unreadable-file";
}

function regularFile(
  path: string,
): Promise<Located<{ readonly size: number }>> {
  return lstat(path).then(
    (info) => (info.isFile() ? { size: info.size } : { failure: "missing" }),
    failed,
  );
}

function located(path: string): Promise<Located<{ readonly path: string }>> {
  return realpath(path).then((real) => ({ path: real }), failed);
}

async function themeDocument(folder: string): Promise<ThemeDocument> {
  const path = join(folder, "theme.json");
  const file = await regularFile(path);
  if ("failure" in file)
    return { codes: [failureCode(file.failure, "missing-theme-file")] };
  if (file.size > themeFileLimit) return { codes: ["theme-file-too-large"] };
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return { codes: ["unreadable-file"] };
  try {
    const value: unknown = JSON.parse(text);
    return { codes: [], value };
  } catch {
    return { codes: ["invalid-theme-json"] };
  }
}

async function assetFile(folder: string, path: string): Promise<AssetFile> {
  const [theme, file] = await Promise.all([
    located(folder),
    located(join(folder, path)),
  ]);
  if ("failure" in theme)
    return { codes: [failureCode(theme.failure, "missing-asset")] };
  if ("failure" in file)
    return { codes: [failureCode(file.failure, "missing-asset")] };
  if (!file.path.startsWith(join(theme.path, "assets") + sep))
    return { codes: ["invalid-asset-path"] };
  const info = await regularFile(file.path);
  if ("failure" in info)
    return { codes: [failureCode(info.failure, "missing-asset")] };
  const sized = assetSizeCodes(info.size);
  if (sized.length > 0) return { codes: sized };
  const bytes = await readFile(file.path).catch(() => undefined);
  if (bytes === undefined) return { codes: ["unreadable-file"] };
  const codes = assetCodes({ path, bytes });
  return codes.length > 0 ? { codes } : { bytes };
}

async function assetFileCodes(
  folder: string,
  path: string,
): Promise<readonly string[]> {
  const file = await assetFile(folder, path);
  return "codes" in file ? file.codes : [];
}

function nameCodes(name: string): readonly string[] {
  if (!themeName.test(name)) return ["invalid-folder-name"];
  return name === "auto" ? ["reserved-theme-name"] : [];
}

function entry(
  found: FoundTheme,
  checked: {
    readonly codes: readonly string[];
    readonly title?: string | null | undefined;
    readonly colorScheme?: ColorScheme | null | undefined;
  },
): ThemeEntry {
  const codes = [...new Set([...nameCodes(found.name), ...checked.codes])];
  return {
    ...found,
    title: checked.title ?? null,
    colorScheme: checked.colorScheme ?? null,
    usable: codes.length === 0,
    codes: codes.sort(),
    replaces: [],
  };
}

async function folderTheme(
  found: FoundTheme,
  folder: string,
): Promise<LoadedTheme> {
  const document = await themeDocument(folder);
  const empty = { folder, document: {}, assets: [] };
  if (document.codes.length > 0)
    return { ...empty, entry: entry(found, document) };
  const checked = checkedTheme(document.value);
  const assets = await Promise.all(
    checked.assets.map((path) => assetFileCodes(folder, path)),
  );
  return {
    folder,
    document: record(document.value) ?? {},
    assets: checked.assets,
    entry: entry(found, {
      ...checked,
      codes: [...checked.codes, ...assets.flat()],
    }),
  };
}

function absent(error: unknown): readonly Dirent[] {
  if (absentCode(error)) return [];
  throw new Error(
    `unreadable-theme-folder: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

interface PlaceEntry {
  readonly found: FoundTheme;
  readonly path: string;
  readonly folder: boolean;
}

async function placeEntries(
  place: ThemePlace,
  folder: string,
): Promise<readonly PlaceEntry[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(absent);
  return entries
    .filter((item) => !item.name.startsWith(".") && !item.isFile())
    .map((item) => ({
      found: { name: item.name, place },
      path: join(folder, item.name),
      folder: item.isDirectory(),
    }));
}

async function themeEntries(
  folders: ThemeFolders,
): Promise<readonly PlaceEntry[]> {
  const found = await Promise.all([
    placeEntries("project", folders.project),
    placeEntries("user", folders.user),
    placeEntries("built-in", folders.builtIn),
  ]);
  return found.flat();
}

function placeTheme(item: PlaceEntry): Promise<LoadedTheme> {
  if (item.folder) return folderTheme(item.found, item.path);
  return Promise.resolve({
    folder: item.path,
    document: {},
    assets: [],
    entry: entry(item.found, { codes: ["invalid-theme-folder"] }),
  });
}

async function chosenTheme(
  item: PlaceEntry,
  entries: readonly PlaceEntry[],
): Promise<LoadedTheme> {
  const theme = await placeTheme(item);
  const replaces = entries
    .filter((other) => other.found.name === item.found.name && other !== item)
    .map((other) => other.found.place);
  return { ...theme, entry: { ...theme.entry, replaces } };
}

export async function loadedThemes(
  folders: ThemeFolders,
): Promise<readonly LoadedTheme[]> {
  const entries = await themeEntries(folders);
  const chosen = entries.filter(
    (item, index) =>
      entries.findIndex((other) => other.found.name === item.found.name) ===
      index,
  );
  const themes = await Promise.all(
    chosen.map((item) => chosenTheme(item, entries)),
  );
  return themes.toSorted(
    (first, second) =>
      Number(first.entry.name > second.entry.name) -
      Number(first.entry.name < second.entry.name),
  );
}

export async function loadedTheme(
  folders: ThemeFolders,
  name: string,
): Promise<LoadedTheme | null> {
  const entries = await themeEntries(folders);
  const item = entries.find((other) => other.found.name === name);
  return item === undefined ? null : await chosenTheme(item, entries);
}

export async function themeList(
  folders: ThemeFolders,
): Promise<readonly ThemeEntry[]> {
  return (await loadedThemes(folders)).map((theme) => theme.entry);
}

export async function themeAssetBytes(
  theme: LoadedTheme,
  path: string,
): Promise<Uint8Array | null> {
  if (!theme.entry.usable || !theme.assets.includes(path)) return null;
  const file = await assetFile(theme.folder, path);
  return "bytes" in file ? file.bytes : null;
}
