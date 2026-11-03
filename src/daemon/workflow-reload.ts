import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { record } from "../protocol.ts";
import type {
  WorkflowReload,
  WorkflowReloadPort,
} from "../service/workflow-reload.ts";
import { serviceLimits } from "../service/service.ts";
import {
  isWorkflowDeclaration,
  type DeclaredWorkflow,
} from "../workflow-declaration.ts";
import {
  workflowRefusals,
  type WorkflowRefusal,
} from "../workflow-refusals.ts";
import type { DaemonSettings } from "./daemon-adapters.ts";
import {
  ticketRegistrations,
  ticketRegistrationTable,
} from "./ticket-registration.ts";
import type {
  WorkflowBundleLoader,
  WorkflowGeneration,
  workflowGenerations,
} from "./workflow-generations.ts";
import { scheduledDeclarations } from "./workflow-schedules.ts";

interface PreparedBundle {
  readonly kind: "prepared";
  readonly bundleDigest: string;
  readonly manifests: Readonly<Record<string, string>>;
  readonly declarations: readonly DeclaredWorkflow[];
  readonly workflowRefusals: readonly WorkflowRefusal[];
}

type Refused = Extract<WorkflowReload, { readonly kind: "refused" }>;

const executed = promisify(execFile);

function refused(code: string, detail: string): Refused {
  return { kind: "refused", code, detail };
}

export function queueWorkflowId(settings: {
  readonly declarations?: readonly DeclaredWorkflow[];
}): string | undefined {
  return settings.declarations?.find(
    (declaration) => declaration.queue === true,
  )?.workflowId;
}

export async function daemonRegistrations(settings: DaemonSettings) {
  const conflict = settings.workflowRefusals?.find((refusal) =>
    refusal.codes.includes("queue-workflow-conflict"),
  );
  if (conflict !== undefined)
    return {
      table: [],
      admitted: {
        kind: "rejected" as const,
        detail: `queue-workflow-conflict: ${conflict.scope} ${conflict.label}`,
      },
    };

  const table = ticketRegistrationTable(
    {
      repository: settings.repository,
      command: settings.ticketCommand,
      nextCommand: settings.nextCommand,
      githubCommand: settings.githubCommand,
    },
    settings.declarations,
  );
  const admitted = await ticketRegistrations(settings.manifests, {
    table,
    commands: settings.commands ?? {},
    ...(settings.bundleDigest === undefined
      ? {}
      : { bundleDigest: settings.bundleDigest }),
  });
  return {
    table,
    admitted:
      admitted.kind === "rejected"
        ? admitted
        : {
            ...admitted,
            registrations: admitted.registrations.map((registration) => ({
              ...registration,
              ...(settings.queueMilliseconds !== undefined &&
              registration.workflowId === queueWorkflowId(settings)
                ? { admission: settings.queueLanes ?? 1, queue: true }
                : {}),
            })),
          },
  };
}

function declaredWorkflows(
  value: unknown,
): readonly DeclaredWorkflow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const declarations: DeclaredWorkflow[] = [];
  for (const entry of value) {
    const { functionName, ...declaration } = record(entry) ?? {};
    if (typeof functionName !== "string" || !isWorkflowDeclaration(declaration))
      return undefined;
    declarations.push({ ...declaration, functionName });
  }
  return declarations;
}

function manifestPaths(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  const fields = record(value);
  if (fields === undefined) return undefined;
  const entries = Object.entries(fields);
  const paths = entries.filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return paths.length === entries.length
    ? Object.fromEntries(paths)
    : undefined;
}

function parsedOutput(
  output: string,
): Readonly<Record<string, unknown>> | undefined {
  try {
    return record(JSON.parse(output));
  } catch {
    return undefined;
  }
}

function preparedBundle(output: string): PreparedBundle | Refused {
  const value = parsedOutput(output);
  const error = value?.["error"];
  if (typeof error === "string") return refused("reload-failed", error);
  const bundleDigest = value?.["bundleDigest"];
  const manifests = manifestPaths(value?.["manifests"]);
  const declarations = declaredWorkflows(value?.["declarations"]);
  if (
    typeof bundleDigest !== "string" ||
    manifests === undefined ||
    declarations === undefined
  )
    return refused(
      "reload-failed",
      "The reload command printed no workflow bundle.",
    );
  return {
    kind: "prepared",
    bundleDigest,
    manifests,
    declarations,
    workflowRefusals: workflowRefusals(value?.["workflowRefusals"]),
  };
}

async function prepared(
  command: readonly string[],
): Promise<PreparedBundle | Refused> {
  const [executable = "", ...fixed] = command;
  const output = await executed(executable, fixed, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).then(
    (result) => result.stdout,
    (error: unknown) => String(Reflect.get(Object(error), "stdout")),
  );
  return preparedBundle(output);
}

function restartFacts(declarations: readonly DeclaredWorkflow[]): string {
  return JSON.stringify({
    queue: queueWorkflowId({ declarations }) ?? null,
    schedules: declarations
      .filter((declaration) => declaration.schedule !== undefined)
      .map((declaration) => declaration.workflowId)
      .sort(),
  });
}

type ReloadSettings = DaemonSettings & {
  readonly reloadCommand: readonly string[];
  readonly loadBundle: WorkflowBundleLoader;
};

type Generations = Pick<ReturnType<typeof workflowGenerations>, "replace">;

async function reloaded(
  settings: ReloadSettings & { readonly generations: Generations },
  bundle: PreparedBundle,
): Promise<WorkflowReload> {
  const scheduled = scheduledDeclarations(
    { declarations: bundle.declarations, schedules: settings.schedules },
    {
      repository: settings.repository,
      documentBytes: serviceLimits.documentBytes,
    },
  );
  if (scheduled.kind === "refused")
    return refused("reload-failed", `${scheduled.reason}: ${scheduled.detail}`);
  if (scheduled.declarations.length === 0)
    return refused(
      "reload-no-workflow",
      "The new workflow files admit no workflow.",
    );
  if (
    restartFacts(scheduled.declarations) !==
    restartFacts(settings.declarations ?? [])
  )
    return refused(
      "reload-needs-restart",
      "The queue workflow or the set of scheduled workflows changed. Restart the service.",
    );
  let generation: WorkflowGeneration;
  try {
    generation = await settings.loadBundle(
      join(settings.directory, "workflow-bundles", bundle.bundleDigest),
    );
  } catch (error) {
    return refused(
      "reload-failed",
      `The new bundle did not load: ${String(error)}`,
    );
  }
  const { table, admitted } = await daemonRegistrations({
    ...settings,
    bundleDigest: bundle.bundleDigest,
    manifests: bundle.manifests,
    declarations: scheduled.declarations,
    workflowRefusals: bundle.workflowRefusals,
  });
  if (admitted.kind === "rejected")
    return refused("reload-failed", admitted.detail);
  settings.generations.replace({
    registrations: admitted.registrations,
    table,
    workflows: generation.workflows,
    handler: generation.handler,
  });
  return {
    kind: "reloaded",
    bundleDigest: bundle.bundleDigest,
    workflows: admitted.registrations,
    workflowRefusals: bundle.workflowRefusals,
  };
}

function reloadLine(
  outcome: WorkflowReload,
  digests: {
    readonly previous: string | undefined;
    readonly current: string | undefined;
  },
): string {
  if (outcome.kind === "refused")
    return `Workflow reload: refused ${outcome.code}: ${outcome.detail}\n`;
  return `Workflow reload: ${outcome.kind} ${String(digests.previous)} -> ${String(digests.current)}\n`;
}

async function reloadOutcome(
  settings: ReloadSettings & { readonly generations: Generations },
  previous: string | undefined,
): Promise<WorkflowReload> {
  const bundle = await prepared(settings.reloadCommand);
  if (bundle.kind === "refused") return bundle;
  if (bundle.bundleDigest === previous)
    return { kind: "unchanged", workflowRefusals: bundle.workflowRefusals };
  return reloaded(settings, bundle);
}

export function workflowReload(
  settings: ReloadSettings & { readonly generations: Generations },
): WorkflowReloadPort {
  let { bundleDigest } = settings;
  return async () => {
    const previous = bundleDigest;
    const outcome = await reloadOutcome(settings, previous);
    if (outcome.kind === "reloaded") bundleDigest = outcome.bundleDigest;
    process.stdout.write(
      reloadLine(outcome, { previous, current: bundleDigest }),
    );
    return outcome;
  };
}
