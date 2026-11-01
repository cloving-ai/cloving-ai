import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import packageMetadata from "#package" with { type: "json" };
import { nativeHarness, type HarnessSettings } from "../harness-defaults.ts";
import { record } from "../protocol.ts";
import { listedSetting } from "./doctor-local.ts";
import { chatStores } from "./chat-stores.ts";
import { discoverHarnesses } from "./harness-probes.ts";
import { initPrompt, type InitPromptFacts } from "./init-prompt.ts";
import type { ProbeRunner } from "./probe-command.ts";
import { projectSettings } from "./project-settings.ts";
import { runtimeDirectory } from "./runtime-directory.ts";
import { prRepository } from "./watch-pr-identity.ts";

interface PromptContext {
  readonly repository: string | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly probe: ProbeRunner;
}

async function files(repository: string): Promise<readonly string[]> {
  const folder = join(repository, ".cloving");
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      join(entry.parentPath, entry.name).slice(repository.length + 1),
    )
    .sort();
}

async function toolList(
  tool: string,
  context: PromptContext & { readonly repository: string },
) {
  const result = await context.probe(process.execPath, {
    arguments: [
      join(
        import.meta.dirname,
        "../../tools",
        `${tool}-command${extname(import.meta.filename)}`,
      ),
      "list",
      "--json",
    ],
    env: context.environment,
    directory: context.repository,
    milliseconds: 60000,
    bytes: 1024 * 1024,
  });
  if (result.reason !== null)
    throw new Error(`${tool}-inspection-failed: ${result.reason}`);
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows)) throw new Error(`${tool}-inspection-invalid`);
  return Array.from<unknown>(rows).map((row) => {
    const fields = record(row);
    if (fields === undefined) throw new Error(`${tool}-inspection-invalid`);
    return fields;
  });
}

async function inventory(
  context: PromptContext & { readonly repository: string },
) {
  const [currentFiles, templates, workflows] = await Promise.all([
    files(context.repository),
    toolList("template", context),
    toolList("workflow", context),
  ]);
  return {
    files: currentFiles,
    templates: templates.map(
      (row) =>
        `${String(row["name"])}: ${String(row["points"])} decision points`,
    ),
    workflows: workflows.map((row) => {
      const { scope, workflowId, file, admitted, codes } = row;
      if (
        typeof scope !== "string" ||
        (workflowId !== null && typeof workflowId !== "string") ||
        typeof file !== "string"
      )
        throw new Error("workflow-inspection-invalid");
      return { scope, workflowId, file, admitted, codes };
    }),
  };
}

function selectedWorker(
  name: string,
  harness: HarnessSettings["harness"],
): string {
  if (nativeHarness(name)) return `native ${name}`;
  if (harness?.name === name && harness.turn !== undefined)
    return `one-shot ${name}`;
  return "no worker; ask for harness.turn";
}

async function githubFacts(
  context: PromptContext & { readonly repository: string },
) {
  const { environment, repository } = context;
  const given = { env: environment, directory: repository };
  const github = listedSetting(environment["CLOVING_GH_COMMAND"]) ?? ["gh"];
  const remote = await context.probe("git", {
    ...given,
    arguments: ["remote", "get-url", "origin"],
  });
  const origin = remote.reason === null ? remote.stdout.trim() : "unavailable";
  const host = prRepository(origin)?.host ?? "github.com";
  const login = await context.probe(github[0] ?? "", {
    ...given,
    arguments: [
      ...github.slice(1),
      "api",
      "user",
      "--hostname",
      host,
      "--jq",
      ".login",
    ],
  });
  return {
    origin,
    login: login.reason === null ? login.stdout.trim() : "unavailable",
  };
}

export async function initPromptFacts(
  context: PromptContext,
): Promise<InitPromptFacts> {
  const repository = context.repository;
  if (repository === undefined)
    throw new Error(
      "repository-unknown: Change to a git repository or use --repository <directory>.",
    );
  const { environment, harness } = projectSettings(
    context.environment,
    repository,
  );
  const [github, discovery, current, stores] = await Promise.all([
    githubFacts({ ...context, repository, environment }),
    discoverHarnesses({ env: environment, probe: context.probe }),
    inventory({ ...context, repository, environment }),
    chatStores(environment["HOME"]),
  ]);
  const name = environment["CLOVING_WORKER"] ?? harness?.name ?? "claude";
  return {
    version: packageMetadata.version,
    repository,
    ...github,
    node: process.version,
    harnesses: discovery.entries.map(({ name, version, working }) => ({
      name,
      version,
      working,
    })),
    defaultHarness: name,
    worker: selectedWorker(name, harness),
    runtime: runtimeDirectory(environment, repository) ?? "unavailable",
    chatStores: stores,
    ...current,
  };
}

export async function initPromptCommand(
  context: PromptContext,
): Promise<number> {
  try {
    process.stdout.write(initPrompt(await initPromptFacts(context)));
    return 0;
  } catch (error) {
    process.stderr.write(
      "init-prompt-failed: " +
        (error instanceof Error ? error.message : "unavailable") +
        "\n",
    );
    return 1;
  }
}
