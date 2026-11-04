import { join } from "node:path";
import { record } from "../protocol.ts";
import type {
  WorkflowBundleReload,
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
import { reloadCommandOutput } from "./reload-command.ts";
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
import {
  keptDigests,
  profileRefusal,
  reloadedSettings,
  settingChanges,
  type ReloadedSettings,
  type SettingDigests,
  type TurnSettingsSource,
} from "./settings-reload.ts";

interface PreparedBundle extends ReloadedSettings {
  readonly kind: "prepared";
  readonly bundleDigest: string;
  readonly manifests: Readonly<Record<string, string>>;
  readonly declarations: readonly DeclaredWorkflow[];
  readonly workflowRefusals: readonly WorkflowRefusal[];
}

type Refused = Extract<WorkflowReload, { readonly kind: "refused" }>;

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

function outputRefusal(
  value: Readonly<Record<string, unknown>> | undefined,
): Refused | undefined {
  const error = value?.["error"];
  if (typeof error === "string") return refused("reload-failed", error);
  const refusal = record(value?.["refusal"]);
  const code = refusal?.["code"];
  const detail = refusal?.["detail"];
  return typeof code === "string" && typeof detail === "string"
    ? refused(code, detail)
    : undefined;
}

function preparedBundle(
  output: string,
  failure: string,
): PreparedBundle | Refused {
  const value = parsedOutput(output);
  const refusal = outputRefusal(value);
  if (refusal !== undefined) return refusal;
  const bundleDigest = value?.["bundleDigest"];
  const manifests = manifestPaths(value?.["manifests"]);
  const declarations = declaredWorkflows(value?.["declarations"]);
  const settings = reloadedSettings(value);
  if (
    typeof bundleDigest !== "string" ||
    manifests === undefined ||
    declarations === undefined ||
    settings === undefined
  )
    return refused(
      "reload-failed",
      `The reload command printed no workflow bundle.${failure}`,
    );
  return {
    kind: "prepared",
    bundleDigest,
    manifests,
    declarations,
    workflowRefusals: workflowRefusals(value?.["workflowRefusals"]),
    ...settings,
  };
}

async function prepared(
  command: readonly string[],
): Promise<PreparedBundle | Refused> {
  const output = await reloadCommandOutput(command);
  return preparedBundle(output.stdout, output.failure);
}

function restartFacts(declarations: readonly DeclaredWorkflow[]): string {
  const schedules = new Map(
    declarations
      .filter((declaration) => declaration.schedule !== undefined)
      .map(
        (declaration) =>
          [declaration.workflowId, declaration.schedule] as const,
      ),
  );
  return JSON.stringify({
    queue: queueWorkflowId({ declarations }) ?? null,
    schedules: [...schedules.keys()]
      .sort()
      .map((workflowId) => [workflowId, schedules.get(workflowId)]),
  });
}

function refusalName(refusal: WorkflowRefusal): string {
  return `${refusal.scope} ${refusal.label}`;
}

function addedRefusals(
  current: readonly WorkflowRefusal[],
  next: readonly WorkflowRefusal[],
): Refused | undefined {
  const known = new Set(current.map(refusalName));
  const added = next.filter((refusal) => !known.has(refusalName(refusal)));
  if (added.length === 0) return undefined;
  const reasons = added.map(
    (refusal) => `${refusalName(refusal)}: ${refusal.codes.join(", ")}`,
  );
  return refused(
    "reload-failed",
    `The reload gives new workflow refusals: ${reasons.join("; ")}`,
  );
}

type ReloadSettings = DaemonSettings & {
  readonly reloadCommand: readonly string[];
  readonly loadBundle: WorkflowBundleLoader;
  readonly turnSettings: TurnSettingsSource;
};

type Generations = Pick<ReturnType<typeof workflowGenerations>, "replace">;

async function reloaded(
  settings: ReloadSettings & { readonly generations: Generations },
  bundle: PreparedBundle,
): Promise<WorkflowBundleReload> {
  const scheduled = scheduledDeclarations(
    { declarations: bundle.declarations, schedules: settings.schedules },
    {
      repository: settings.repository,
      documentBytes: serviceLimits.documentBytes,
    },
  );
  if (scheduled.kind === "refused")
    return refused("reload-failed", `${scheduled.reason}: ${scheduled.detail}`);
  if (
    restartFacts(scheduled.declarations) !==
    restartFacts(settings.declarations ?? [])
  )
    return refused(
      "reload-needs-restart",
      "The queue workflow or a schedule changed. Restart the service.",
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

interface ReloadState {
  readonly bundleDigest: string | undefined;
  readonly workflowRefusals: readonly WorkflowRefusal[];
  readonly settingDigests: SettingDigests;
}

interface ReloadStep {
  readonly outcome: WorkflowReload;
  readonly state: ReloadState;
}

async function workflowPart(
  settings: ReloadSettings & { readonly generations: Generations },
  prepared: { readonly state: ReloadState; readonly bundle: PreparedBundle },
): Promise<WorkflowBundleReload> {
  const { state, bundle } = prepared;
  const added = addedRefusals(state.workflowRefusals, bundle.workflowRefusals);
  if (added !== undefined) return added;
  if (bundle.bundleDigest === state.bundleDigest)
    return { kind: "unchanged", workflowRefusals: bundle.workflowRefusals };
  return reloaded(settings, bundle);
}

async function reloadOutcome(
  settings: ReloadSettings & { readonly generations: Generations },
  state: ReloadState,
): Promise<ReloadStep> {
  const kept = (outcome: Refused): ReloadStep => ({ outcome, state });
  const bundle = await prepared(settings.reloadCommand);
  if (bundle.kind === "refused") return kept(bundle);
  const profiles = profileRefusal(settings, bundle.turnSettings);
  if (profiles !== undefined)
    return kept(refused(profiles.code, profiles.detail));
  const workflows = await workflowPart(settings, { state, bundle });
  if (workflows.kind === "refused") return kept(workflows);
  const changes = settingChanges(state.settingDigests, bundle.settingDigests);
  settings.turnSettings.replace(bundle.turnSettings);
  return {
    outcome: { ...workflows, ...changes },
    state: {
      bundleDigest:
        workflows.kind === "reloaded"
          ? workflows.bundleDigest
          : state.bundleDigest,
      workflowRefusals: workflows.workflowRefusals,
      settingDigests: keptDigests(state.settingDigests, {
        digests: bundle.settingDigests,
        reloadedFields: changes.reloadedFields,
      }),
    },
  };
}

export function workflowReload(
  settings: ReloadSettings & { readonly generations: Generations },
): WorkflowReloadPort {
  let state: ReloadState = {
    bundleDigest: settings.bundleDigest,
    workflowRefusals: workflowRefusals(settings.workflowRefusals),
    settingDigests: settings.settingDigests ?? {},
  };
  return async () => {
    const previous = state.bundleDigest;
    const step = await reloadOutcome(settings, state);
    state = step.state;
    process.stdout.write(
      reloadLine(step.outcome, { previous, current: state.bundleDigest }),
    );
    return step.outcome;
  };
}
