import type { QueueLimits } from "../queue-room.ts";
import type { WorkflowRefusal } from "../workflow-refusals.ts";
import type { QueueSettingRequest } from "../queue-setting-operation.ts";
import { selectedQueueLimits } from "../queue-setting-limits.ts";
import type { DeclaredWorkflow } from "../workflow-declaration.ts";
import type { WorkflowReload } from "../service/workflow-reload.ts";
import {
  reloadCommandOutput,
  parsedOutput,
  outputRefusal,
} from "./reload-command.ts";
import type { QueueLimitsSource } from "./queue-limits.ts";
import {
  keptDigests,
  reloadedSettings,
  settingChanges,
  type SettingDigests,
  type ReloadedSettings,
} from "./settings-reload.ts";

interface QueueReloadSettings {
  readonly command: readonly string[];
  readonly declarations: readonly DeclaredWorkflow[];
  readonly request: QueueSettingRequest;
  readonly digests: SettingDigests;
  readonly source: QueueLimitsSource;
}

export async function reloadQueueSettings(
  settings: QueueReloadSettings,
): Promise<{
  readonly outcome: WorkflowReload;
  readonly digests: SettingDigests;
}> {
  const prepared = await preparedSettings(settings);
  if (prepared.kind === "refused")
    return { outcome: prepared, digests: settings.digests };
  const next = prepared.settings;
  const changes = settingChanges(settings.digests, next.settingDigests);
  const { request, source } = settings;
  const selected =
    request.scope === "global"
      ? next.queueLimits
      : next.queueWorkflowLimits?.[request.workflowId ?? ""];
  const limits =
    selected === undefined
      ? undefined
      : selectedQueueLimits(source.current(request.workflowId), {
          next: selected,
          request,
        });
  if (limits === undefined)
    return {
      outcome: {
        kind: "refused",
        code: "queue-setting-changed",
        detail:
          "Another lane setting changed separately. Reload or restore that setting before retrying this request.",
      },
      digests: settings.digests,
    };
  const fields = appliedFields(source.current(request.workflowId), {
    next: limits,
    request,
  });
  const reloadedFields = changes.reloadedFields.filter((field) =>
    fields.includes(field),
  );
  source.replaceSetting(request, limits);
  return {
    outcome: {
      kind: "unchanged",
      workflowRefusals: [],
      reloadedFields,
      restartFields: [],
    },
    digests:
      request.scope === "workflow"
        ? settings.digests
        : keptDigests(settings.digests, {
            digests: next.settingDigests,
            reloadedFields,
          }),
  };
}

export async function queueSettingsStep<
  State extends {
    readonly declarations: readonly DeclaredWorkflow[];
    readonly settingDigests: SettingDigests;
    readonly workflowRefusals: readonly WorkflowRefusal[];
  },
>(
  settings: {
    readonly reloadCommand: readonly string[];
    readonly queueLimitSource: QueueLimitsSource;
    readonly request: QueueSettingRequest;
  },
  state: State,
) {
  const next = await reloadQueueSettings({
    command: settings.reloadCommand,
    declarations: state.declarations,
    digests: state.settingDigests,
    source: settings.queueLimitSource,
    request: settings.request,
  });
  const outcome =
    next.outcome.kind === "refused"
      ? next.outcome
      : { ...next.outcome, workflowRefusals: state.workflowRefusals };
  return { outcome, state: { ...state, settingDigests: next.digests } };
}

function appliedFields(
  current: QueueLimits,
  change: { readonly next: QueueLimits; readonly request: QueueSettingRequest },
): readonly string[] {
  const { request, next } = change;
  if (request.scope === "workflow") return ["queues"];
  const field =
    request.field === "lanes"
      ? "queue.globalLanes"
      : "queue.globalWorkingLanes";
  const adjusted =
    request.field === "lanes" &&
    current.global?.workingLanes !== undefined &&
    current.global.workingLanes !== next.global?.workingLanes;
  return adjusted ? [field, "queue.globalWorkingLanes"] : [field];
}

async function preparedSettings(
  settings: QueueReloadSettings,
): Promise<
  | { readonly kind: "prepared"; readonly settings: ReloadedSettings }
  | Extract<WorkflowReload, { readonly kind: "refused" }>
> {
  const output = await reloadCommandOutput([
    ...settings.command,
    "--queue-settings",
    JSON.stringify(settings.declarations),
  ]);
  const value = parsedOutput(output.stdout);
  const refusal = outputRefusal(value);
  if (refusal !== undefined) return refusal;
  const next = reloadedSettings(value);
  if (next === undefined || output.failure !== "")
    return {
      kind: "refused",
      code: "reload-failed",
      detail: `The reload command printed no queue settings.${output.failure}`,
    };
  return { kind: "prepared", settings: next };
}
