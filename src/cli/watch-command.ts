import type { WatchPrSettings } from "./watch-pr-settings.ts";
import type { WatchThemeSettings } from "./watch-themes.ts";
import { defaultWatchPort, watchServer } from "./watch-server.ts";

export interface WatchEnvironment {
  readonly runtimeDirectory: string;
  readonly watchActions?: string;
  readonly watchPr?: WatchPrSettings;
  readonly watchThemes?: WatchThemeSettings;
  readonly client?: string;
  readonly terminal: {
    readonly out: (text: string) => void;
    readonly error: (text: string) => void;
  };
  readonly interrupted: () => Promise<void>;
}

export function watchCommand(
  environment: WatchEnvironment,
  port: number | null,
): Promise<number> {
  return watchServer({
    actions: environment.watchActions ?? "on",
    ...(environment.watchPr === undefined
      ? {}
      : { pullRequests: environment.watchPr }),
    ...(environment.watchThemes === undefined
      ? {}
      : { themes: environment.watchThemes }),
    runtimeDirectory: environment.runtimeDirectory,
    port: port ?? defaultWatchPort,
    client: environment.client ?? "cloving",
    announce: environment.terminal.out,
    complain: environment.terminal.error,
    stopped: environment.interrupted(),
  });
}
