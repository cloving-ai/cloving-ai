import type { ThemeWord } from "../theme-style.ts";
import { element, type Shown } from "./watch-element.ts";
import { counted } from "./watch-render.ts";
import type { WatchTheme, WatchThemes } from "./watch-themes.ts";

export type WatchWords = Readonly<Record<string, ThemeWord>>;

export interface ShownTheme {
  readonly choice: string;
  readonly theme: WatchTheme | null;
  readonly notice: string | null;
}

export interface ThemeControls {
  readonly shown: ShownTheme;
  readonly themes: readonly WatchTheme[];
  readonly onChoose: (name: string) => void;
}

export function themeName(view: {
  readonly choice: string;
  readonly dark: boolean;
}): string {
  if (view.choice !== "auto") return view.choice;
  return view.dark ? "dark" : "light";
}

export function themeReason(themes: WatchThemes, name: string): string | null {
  const theme = themes.themes.find((item) => item.name === name);
  if (themes.failure !== null) return themes.failure;
  if (theme === undefined) return `no theme folder has the name ${name}`;
  return `the theme ${name} is refused: ${theme.codes.join(", ")}`;
}

export function shownTheme(
  themes: WatchThemes,
  view: { readonly choice: string | null; readonly dark: boolean },
): ShownTheme {
  const choice = view.choice ?? themes.setting;
  const name = themeName({ choice, dark: view.dark });
  const theme = themes.themes.find((item) => item.name === name);
  if (theme?.usable === true) return { choice, theme, notice: null };
  const quiet =
    choice === "auto" && theme === undefined && themes.failure === null;
  return {
    choice,
    theme: null,
    notice: quiet
      ? null
      : `The page uses the default theme: ${String(themeReason(themes, name))}.`,
  };
}

export function wordText(
  words: WatchWords | undefined,
  word: { readonly key: string; readonly text: string },
): string {
  const value = words?.[word.key];
  return typeof value === "string" ? value : word.text;
}

export function countText(
  words: WatchWords | undefined,
  count: {
    readonly key: string;
    readonly count: number;
    readonly noun: string;
  },
): string {
  const value = words?.[count.key];
  if (value === undefined || typeof value === "string")
    return counted(count.count, count.noun);
  const form = count.count === 1 ? value.one : value.other;
  return form.includes("{count}")
    ? form.replaceAll("{count}", String(count.count))
    : `${String(count.count)} ${form}`;
}

export function labelWord(words: WatchWords | undefined, name: string): string {
  const keys: Readonly<Record<string, string>> = {
    Done: "column.done",
    Stopped: "column.stopped",
    "Agent turn": "station.agent",
    "Your review": "station.review",
    "Needs attention": "state.attention",
  };
  const key = Object.hasOwn(keys, name) ? keys[name] : undefined;
  return key === undefined ? name : wordText(words, { key, text: name });
}

export function ThemeMenu(props: { readonly theme: ThemeControls }): Shown {
  const { shown, themes, onChoose } = props.theme;
  const usable = themes.filter((theme) => theme.usable);
  const listed =
    shown.choice === "auto" ||
    usable.some((theme) => theme.name === shown.choice);
  return element("label", {
    class: "theme-menu",
    children: [
      "Theme ",
      element("select", {
        value: shown.choice,
        onChange: (event: {
          readonly currentTarget: { readonly value: string };
        }) => {
          onChoose(event.currentTarget.value);
        },
        children: [
          element("option", { value: "auto", children: "Auto" }),
          ...usable.map((theme) =>
            element("option", {
              key: theme.name,
              value: theme.name,
              children: theme.title ?? theme.name,
            }),
          ),
          listed
            ? null
            : element("option", {
                value: shown.choice,
                disabled: true,
                children: `${shown.choice} (not usable)`,
              }),
        ],
      }),
    ],
  });
}

export function ThemeNotice(props: { readonly theme: ThemeControls }): Shown {
  const { notice } = props.theme.shown;
  return notice === null
    ? null
    : element("p", { class: "theme-notice", role: "status", children: notice });
}
