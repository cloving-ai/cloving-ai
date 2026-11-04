import { oneLine } from "./terminal-text.ts";
import { themeFolders, themeList, type ThemeEntry } from "./theme-folders.ts";

function themeLine(theme: ThemeEntry): string {
  const state = theme.usable ? "usable" : `refused: ${theme.codes.join(", ")}`;
  const replaces =
    theme.replaces.length === 0
      ? ""
      : `; replaces ${theme.replaces.join(", ")}`;
  const title =
    theme.title === null ? "" : ` ${oneLine(JSON.stringify(theme.title))}`;
  return `${oneLine(theme.name)} (${theme.place}, ${state}${replaces})${title}\n`;
}

export async function themesCommand(options: {
  readonly repository: string | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly json: boolean;
}): Promise<number> {
  const { repository, environment } = options;
  if (repository === undefined) {
    process.stderr.write(
      "repository-unknown: Change to a git repository, or use --repository <directory>.\n",
    );
    return 1;
  }
  const themes = await themeList(
    themeFolders({ repository, environment }),
  ).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  if (themes instanceof Error) {
    process.stderr.write(`${themes.message}\n`);
    return 1;
  }
  process.stdout.write(
    options.json
      ? JSON.stringify(themes) + "\n"
      : themes.map(themeLine).join(""),
  );
  return 0;
}
