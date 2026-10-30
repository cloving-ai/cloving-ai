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

export async function initCommand(context: {
  readonly repository: string | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly probe: ProbeRunner;
  readonly harness: string | undefined;
  readonly start: (request: HarnessStartRequest) => Promise<number | null>;
}): Promise<number> {
  if (context.repository === undefined) {
    process.stderr.write("not-a-repository: run git init.\n");
    return 1;
  }
  try {
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
