import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configurationRoot } from "../project-settings.ts";
import { record } from "../protocol.ts";
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

async function assetFileCodes(
  folder: string,
  path: string,
): Promise<readonly string[]> {
  const [theme, file] = await Promise.all([
    located(folder),
    located(join(folder, path)),
  ]);
  if ("failure" in theme) return [failureCode(theme.failure, "missing-asset")];
  if ("failure" in file) return [failureCode(file.failure, "missing-asset")];
  if (!file.path.startsWith(join(theme.path, "assets") + sep))
    return ["invalid-asset-path"];
  const info = await regularFile(file.path);
  if ("failure" in info) return [failureCode(info.failure, "missing-asset")];
  const sized = assetSizeCodes(info.size);
  if (sized.length > 0) return sized;
  const bytes = await readFile(file.path).catch(() => undefined);
  if (bytes === undefined) return ["unreadable-file"];
  return assetCodes({ path, bytes });
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
): Promise<ThemeEntry> {
  const document = await themeDocument(folder);
  if (document.codes.length > 0) return entry(found, document);
  const checked = checkedTheme(document.value);
  const assets = await Promise.all(
    checked.assets.map((path) => assetFileCodes(folder, path)),
  );
  return entry(found, {
    ...checked,
    codes: [...checked.codes, ...assets.flat()],
  });
}

function absent(error: unknown): readonly Dirent[] {
  if (absentCode(error)) return [];
  throw new Error(
    `unreadable-theme-folder: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

async function placeThemes(
  place: ThemePlace,
  folder: string,
): Promise<readonly ThemeEntry[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(absent);
  const themes = entries
    .filter((item) => !item.name.startsWith(".") && !item.isFile())
    .map((item) => {
      const found = { name: item.name, place };
      return item.isDirectory()
        ? folderTheme(found, join(folder, item.name))
        : Promise.resolve(entry(found, { codes: ["invalid-theme-folder"] }));
    });
  return Promise.all(themes);
}

export async function themeList(
  folders: ThemeFolders,
): Promise<readonly ThemeEntry[]> {
  const found = await Promise.all([
    placeThemes("project", folders.project),
    placeThemes("user", folders.user),
    placeThemes("built-in", folders.builtIn),
  ]);
  const chosen = new Map<string, ThemeEntry>();
  for (const theme of found.flat()) {
    const current = chosen.get(theme.name);
    chosen.set(
      theme.name,
      current === undefined
        ? theme
        : { ...current, replaces: [...current.replaces, theme.place] },
    );
  }
  return [...chosen.values()].sort(
    (first, second) =>
      Number(first.name > second.name) - Number(first.name < second.name),
  );
}
