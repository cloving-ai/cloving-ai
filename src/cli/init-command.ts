import { createInterface } from "node:readline/promises";
import {
  harnessStartRequest,
  type HarnessStartRequest,
} from "../harness-start.ts";
import type { HarnessEntry } from "./harness-probes.ts";
import type { ProbeRunner } from "./probe-command.ts";
import { changeConfigFile } from "./config-file.ts";
import { chooseHarness, selectedHarness } from "./init-selection.ts";
import { privateSettingsPath, projectSettings } from "./project-settings.ts";

export async function chooseInitPath(context: {
  readonly question: (text: string) => Promise<string>;
}): Promise<"local" | "factory"> {
  const answer = (
    await context.question(
      "1. Try one task locally\n2. Build my factory\nSelect 1 or 2: ",
    )
  ).trim();
  if (answer === "1") return "local";
  if (answer === "2") return "factory";
  throw new Error("path-not-selected");
}

export async function initCommand(context: {
  readonly repository: string | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly probe: ProbeRunner;
  readonly harness: string | undefined;
  readonly path: "local" | "factory" | undefined;
  readonly applyLocal: (repository: string) => Promise<number>;
  readonly start: (request: HarnessStartRequest) => Promise<number | null>;
}): Promise<number> {
  if (context.repository === undefined) {
    process.stderr.write("not-a-repository: run git init.\n");
    return 1;
  }
  try {
    const path = context.path ?? (await promptedPath());
    const entry =
      context.harness === undefined
        ? await promptHarness({ ...context, repository: context.repository })
        : await selectedHarness(context.harness, context);
    await changeConfigFile(
      privateSettingsPath(context.environment, context.repository),
      {
        harness: { name: entry.name, kind: entry.kind, path: entry.path },
        scope: "private",
      },
    );
    if (path === "local") return await context.applyLocal(context.repository);
    const request = harnessStartRequest(entry, {
      repository: context.repository,
      environment: context.environment,
      message: "run `cloving init-prompt`",
    });
    const status = await context.start(request);
    if (status !== null) return status;
    process.stderr.write(
      "Open your agent in this repository and tell it: run `cloving init-prompt`.\n",
    );
    return 1;
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : "init-failed") + "\n",
    );
    return 2;
  }
}

async function promptedPath(): Promise<"local" | "factory"> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "factory";
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await chooseInitPath({
      question: (text) => terminal.question(text),
    });
  } finally {
    terminal.close();
  }
}

async function promptHarness(context: {
  readonly repository: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly probe: ProbeRunner;
}): Promise<HarnessEntry> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("harness-not-selected");
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await chooseHarness({
      ...context,
      current: projectSettings(context.environment, context.repository).harness,
      question: (text) => terminal.question(text),
    });
  } finally {
    terminal.close();
  }
}
