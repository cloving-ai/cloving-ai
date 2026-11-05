import type { ColorScheme } from "../theme-check.ts";
import {
  themeClasses,
  themeRule,
  themeWords,
  type ThemeWord,
} from "../theme-style.ts";
import {
  loadedTheme,
  loadedThemes,
  themeAssetBytes,
  type LoadedTheme,
  type ThemeFolders,
} from "./theme-folders.ts";

export interface WatchThemeSettings {
  readonly setting: string;
  readonly folders: ThemeFolders;
}

export interface WatchTheme {
  readonly name: string;
  readonly title: string | null;
  readonly colorScheme: ColorScheme | null;
  readonly usable: boolean;
  readonly codes: readonly string[];
  readonly classes: readonly string[];
  readonly words: Readonly<Record<string, ThemeWord>>;
}

export interface WatchThemes {
  readonly setting: string;
  readonly style: string;
  readonly themes: readonly WatchTheme[];
  readonly failure: string | null;
}

function watchTheme(theme: LoadedTheme): WatchTheme {
  const { name, title, colorScheme, usable, codes } = theme.entry;
  return {
    name,
    title,
    colorScheme,
    usable,
    codes,
    classes: usable ? themeClasses(theme.document) : [],
    words: usable ? themeWords(theme.document) : {},
  };
}

export async function watchThemes(
  settings: WatchThemeSettings,
): Promise<WatchThemes> {
  const { setting } = settings;
  try {
    const themes = await loadedThemes(settings.folders);
    return {
      setting,
      style: themes
        .filter((theme) => theme.entry.usable)
        .map((theme) =>
          themeRule({ name: theme.entry.name, document: theme.document }),
        )
        .join("\n"),
      themes: themes.map(watchTheme),
      failure: null,
    };
  } catch (error) {
    return {
      setting,
      style: "",
      themes: [],
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function themeAsset(
  folders: ThemeFolders,
  request: { readonly name: string; readonly path: string },
): Promise<Uint8Array | null> {
  const theme = await loadedTheme(folders, request.name).catch(() => null);
  return theme === null ? null : themeAssetBytes(theme, request.path);
}

const assetAddress =
  /^\/themes\/([a-z][a-z0-9-]*)\/(assets(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+)$/;
const assetTypes: Readonly<Record<string, string>> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

export async function themeFile(
  folders: ThemeFolders,
  address: string,
): Promise<{ readonly type: string; readonly body: Uint8Array } | null> {
  const [, name, path] = assetAddress.exec(address) ?? [];
  if (name === undefined || path === undefined) return null;
  const type = Object.entries(assetTypes).find(([extension]) =>
    path.endsWith(extension),
  )?.[1];
  if (type === undefined) return null;
  const body = await themeAsset(folders, { name, path });
  return body === null ? null : { type, body };
}
