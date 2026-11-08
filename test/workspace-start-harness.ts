import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  workspaceStart,
  type WorkspaceHost,
  type WorkspaceStart,
  type WorkspaceWatch,
} from "../src/cli/workspace-start.ts";

export const root = realpathSync(
  mkdtempSync(join(tmpdir(), "cloving-workspace-")),
);
process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});
export const alpha = join(root, "alpha");
export const beta = join(root, "beta");
await mkdir(alpha);
await mkdir(beta);

export const pair = {
  version: 1,
  repositories: [
    { path: alpha, name: "alpha" },
    { path: beta, name: "beta" },
  ],
};

export interface Started {
  readonly status: number;
  readonly printed: string;
  readonly refused: string;
  readonly hosts: readonly WorkspaceHost[];
  readonly watches: readonly WorkspaceWatch[];
}

export async function servedHost(host: WorkspaceHost): Promise<void> {
  await mkdir(host.runtime, { recursive: true });
  await writeFile(join(host.runtime, "control.sock"), "");
}

function watchedHost(watching: Promise<unknown>) {
  return async (host: WorkspaceHost): Promise<number> => {
    await servedHost(host);
    await watching;
    return 0;
  };
}

async function workspaceFolder(workspace: unknown): Promise<string> {
  const configuration = mkdtempSync(join(root, "configuration-"));
  if (workspace === undefined) return configuration;
  await mkdir(join(configuration, "cloving"));
  await writeFile(
    join(configuration, "cloving/workspace.json"),
    typeof workspace === "string" ? workspace : JSON.stringify(workspace),
  );
  return configuration;
}

export async function started(input: {
  readonly workspace: unknown;
  readonly environment?: NodeJS.ProcessEnv;
  readonly repositories?: Readonly<Record<string, string>>;
  readonly hosted?: WorkspaceStart["hosted"];
  readonly watched?: WorkspaceStart["watched"];
  readonly watchRestart?: WorkspaceStart["watchRestart"];
}): Promise<Started> {
  const output = { printed: "", refused: "" };
  const hosts: WorkspaceHost[] = [];
  const watches: WorkspaceWatch[] = [];
  const watching = Promise.withResolvers<undefined>();
  const environment: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: await workspaceFolder(input.workspace),
    XDG_STATE_HOME: join(root, "state"),
    ...input.environment,
  };
  if (environment["CLOVING_WATCH_PORT"] === "off") watching.resolve(undefined);
  const hosted = input.hosted ?? watchedHost(watching.promise);
  const repositories = input.repositories ?? { [alpha]: alpha, [beta]: beta };
  const status = await workspaceStart({
    options: ["--reset-queue"],
    environment,
    home: root,
    repositoryDirectory: (directory) => repositories[directory],
    processId: process.pid,
    hosted: (host) => {
      hosts.push(host);
      return hosted(host);
    },
    watched: (watch) => {
      watches.push(watch);
      watching.resolve(undefined);
      return input.watched?.(watch) ?? Promise.resolve(0);
    },
    ...(input.watchRestart === undefined
      ? {}
      : { watchRestart: input.watchRestart }),
    print: (text) => {
      output.printed += text;
    },
    refuse: (text) => {
      output.refused += text;
    },
  });
  return { status, ...output, hosts, watches };
}
