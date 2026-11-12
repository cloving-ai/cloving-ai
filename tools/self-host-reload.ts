import { mkdtemp, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { absoluteWorkflowFolder } from "../src/project-settings.ts";
import { record } from "../src/protocol.ts";
import {
  configurationDigests,
  configuredTurnSettings,
  projectConfiguration,
} from "./project-configuration.ts";
import { preparedBundle } from "./self-host-project.ts";
import { reloadedQueueLimits } from "./self-host-queue.ts";
import type { DeclaredWorkflow } from "../src/workflow-declaration.ts";
import { workflowLimits, type WorkflowLimits } from "../src/workflow-limits.ts";

const settings = record(JSON.parse(String(process.argv[2]))) ?? {};

function optional(name: string): string | undefined {
  const value = settings[name];
  return typeof value === "string" ? value : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (value === undefined)
    throw new Error(`The reload program needs the start setting ${name}.`);
  return value;
}

function limitText(value: unknown): string | undefined {
  return typeof value === "number" ? String(value) : undefined;
}

function startLimits(): WorkflowLimits {
  const limits = record(settings["limits"]);
  return workflowLimits({
    CLOVING_LIMIT_EFFECTS: limitText(limits?.["effects"]),
    CLOVING_LIMIT_CHAIN: limitText(limits?.["chain"]),
  });
}

function startEnvironment(): NodeJS.ProcessEnv {
  const fileVariables = settings["fileVariables"];
  const listed: readonly unknown[] = Array.isArray(fileVariables)
    ? fileVariables
    : [];
  const names = new Set([...listed, "CLOVING_PROFILES"]);
  const profilesFile = optional("profilesFile");
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !names.has(name)),
    ),
    ...(profilesFile === undefined ? {} : { CLOVING_PROFILES: profilesFile }),
  };
}

async function reloadedSettings(repository: string) {
  const configuration = await projectConfiguration(
    repository,
    startEnvironment(),
  );
  const turnSettings = await configuredTurnSettings(configuration);
  return {
    configuration,
    userFolder: absoluteWorkflowFolder(
      configuration.environment["CLOVING_WORKFLOW_FOLDER"],
    ),
    turnSettings,
    settingDigests: configurationDigests(configuration, turnSettings.profiles),
  };
}

function settingsRefusal(error: unknown) {
  const detail = String(Reflect.get(Object(error), "message")).replace(
    /^The daemon did not start: /,
    "",
  );
  return { refusal: { code: detail.replace(/:.*$/s, ""), detail } };
}

function reloadedLimits(
  configuration: Awaited<ReturnType<typeof projectConfiguration>>,
  declarations: readonly DeclaredWorkflow[],
) {
  const { environment, sources } = configuration;
  try {
    return {
      queueLimits: reloadedQueueLimits(environment, { declarations, sources }),
    };
  } catch (error) {
    return settingsRefusal(error);
  }
}

async function reloadedBundle(directory: string) {
  const repository = required("repository");
  const reloaded = await reloadedSettings(repository).catch(settingsRefusal);
  if ("refusal" in reloaded) return reloaded;
  const { userFolder, configuration, ...turns } = reloaded;
  const project = await mkdtemp(join(directory, "reload-"));
  try {
    const prepared = await preparedBundle({
      product: resolve(import.meta.dirname, ".."),
      project,
      recordedProject: join(directory, "project"),
      repository,
      home: required("home"),
      xdgConfigHome: optional("xdgConfigHome"),
      userFolder,
      limits: startLimits(),
    });
    const limits = reloadedLimits(configuration, prepared.declarations);
    if ("refusal" in limits) return limits;
    const bundle = join(directory, "workflow-bundles", prepared.bundleDigest);
    return {
      ...prepared,
      manifests: Object.fromEntries(
        Object.entries(prepared.manifests).map(([name, path]) => [
          name,
          join(bundle, basename(path)),
        ]),
      ),
      ...turns,
      ...limits,
    };
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

const directory = required("directory");
try {
  const output = await reloadedBundle(directory);
  process.stdout.write(JSON.stringify(output));
  if ("refusal" in output) process.exitCode = 1;
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error) }));
  process.exitCode = 1;
}
