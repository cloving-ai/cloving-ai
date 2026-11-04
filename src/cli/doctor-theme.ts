import type { DoctorObservation } from "../doctor-report.ts";
import { oneLine } from "./terminal-text.ts";
import { themeFolders, themeList } from "./theme-folders.ts";

export async function themeObservation(input: {
  readonly repository: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): Promise<DoctorObservation> {
  const name = input.environment["CLOVING_WATCH_THEME"] ?? "auto";
  const setting = `watch.theme ${oneLine(name)}`;
  if (name === "auto") return { result: "ok", detail: setting };
  try {
    const themes = await themeList(themeFolders(input));
    const theme = themes.find((item) => item.name === name);
    if (theme === undefined)
      return {
        result: "fail",
        detail: `${setting}: no theme folder has this name`,
      };
    if (!theme.usable)
      return {
        result: "fail",
        detail: `${setting}: the ${theme.place} theme is refused: ${theme.codes.join(", ")}`,
      };
    return {
      result: "ok",
      detail: `${setting}: the ${theme.place} theme ${oneLine(JSON.stringify(theme.title))}`,
    };
  } catch (error) {
    return {
      result: "fail",
      detail: `${setting}: ${error instanceof Error ? error.message : "themes unavailable"}`,
    };
  }
}
