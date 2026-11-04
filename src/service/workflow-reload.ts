import type { Fields, Reply } from "../protocol.ts";
import type { WorkflowRefusal } from "../workflow-refusals.ts";
import type {
  Registry,
  WorkflowCatalog,
  WorkflowRegistration,
} from "./registry.ts";
import { failed, result } from "./replies.ts";

export interface SettingChanges {
  readonly reloadedFields: readonly string[];
  readonly restartFields: readonly string[];
}

export type WorkflowBundleReload =
  | {
      readonly kind: "reloaded";
      readonly bundleDigest: string;
      readonly workflows: readonly WorkflowRegistration[];
      readonly workflowRefusals: readonly WorkflowRefusal[];
    }
  | {
      readonly kind: "unchanged";
      readonly workflowRefusals: readonly WorkflowRefusal[];
    }
  | {
      readonly kind: "refused";
      readonly code: string;
      readonly detail: string;
    };

export type WorkflowReload =
  | (Exclude<WorkflowBundleReload, { readonly kind: "refused" }> &
      SettingChanges)
  | Extract<WorkflowBundleReload, { readonly kind: "refused" }>;

export type WorkflowReloadPort = () => Promise<WorkflowReload>;

export function workflowFields(context: {
  readonly registry: Registry;
  readonly workflowCatalog?: WorkflowCatalog;
}): Fields {
  const inventory = context.workflowCatalog?.inventory();
  const stages = context.registry.workflowStages;
  return {
    ...(inventory?.bundleDigest === undefined
      ? {}
      : { bundleDigest: inventory.bundleDigest }),
    workflows: context.registry.workflowIds,
    workflowRefusals: inventory?.workflowRefusals ?? [],
    ...(Object.keys(stages).length === 0 ? {} : { workflowStages: stages }),
  };
}

function applied(catalog: WorkflowCatalog, reload: WorkflowReload): Reply {
  if (reload.kind === "refused")
    return failed(reload.code, { detail: reload.detail });
  const previousBundleDigest = catalog.inventory().bundleDigest ?? null;
  if (reload.kind === "reloaded") catalog.replace(reload);
  else catalog.replaceRefusals(reload.workflowRefusals);
  return result("reload", {
    status: reload.kind,
    previousBundleDigest,
    bundleDigest:
      reload.kind === "reloaded" ? reload.bundleDigest : previousBundleDigest,
    workflows: catalog.registry.workflowIds,
    workflowRefusals: reload.workflowRefusals,
    reloadedFields: reload.reloadedFields,
    restartFields: reload.restartFields,
  });
}

export function reloadOperation(parts: {
  readonly port: WorkflowReloadPort;
  readonly catalog: WorkflowCatalog;
}): () => Promise<Reply> {
  let reloading = false;
  return async () => {
    if (reloading)
      return failed("reload-in-progress", {
        detail: "A reload is in work. Wait for its reply.",
      });
    reloading = true;
    try {
      return applied(parts.catalog, await parts.port());
    } finally {
      reloading = false;
    }
  };
}

export function reloadUnavailable(): Promise<Reply> {
  return Promise.resolve(
    failed("reload-unavailable", {
      detail:
        "This service cannot reload the workflow files. Restart it to read them.",
    }),
  );
}
