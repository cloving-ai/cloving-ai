import { watchServer, type WatchSettings } from "../src/cli/watch-server.ts";

export interface DirectWatch {
  readonly address: string;
  readonly complaints: readonly string[];
  readonly finished: Promise<number>;
  readonly stop: () => Promise<number>;
}

export async function directWatch(
  runtimeDirectory: string,
  settings: Partial<WatchSettings> = {},
): Promise<DirectWatch> {
  const ready = Promise.withResolvers<string>();
  const stopped = Promise.withResolvers<undefined>();
  const complaints: string[] = [];
  const finished = watchServer({
    actions: "off",
    runtimeDirectory,
    port: 0,
    client: "cloving",
    announce: (text) => {
      ready.resolve(/(http:\/\/127\.0\.0\.1:\d+\/)/.exec(text)?.[1] ?? "");
    },
    complain: (text) => {
      complaints.push(text);
    },
    stopped: stopped.promise,
    ...settings,
  });
  return {
    address: await ready.promise,
    complaints,
    finished,
    stop: () => {
      stopped.resolve(undefined);
      return finished;
    },
  };
}
