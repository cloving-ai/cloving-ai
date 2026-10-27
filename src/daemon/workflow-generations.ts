import { join } from "node:path";
import type { HostPorts } from "../service/service.ts";
import type { WorkflowFunction } from "../host/start-delivery.ts";
import type { WorkflowHandler } from "../host/world-host.ts";
import type { ExecutionManifest } from "../workflow-admission.ts";
import {
  workflowRegistry,
  type WorkflowRegistration,
} from "../service/registry.ts";
import { workflowPin } from "../broker/workflow-pin.ts";

export interface WorkflowGeneration {
  readonly workflows: Readonly<Record<string, unknown>>;
  readonly handler: WorkflowHandler;
}

export type WorkflowBundleLoader = (
  directory: string,
) => Promise<WorkflowGeneration>;

export function workflowGenerations(settings: {
  readonly directory: string;
  readonly repository: string;
  readonly registrations: readonly WorkflowRegistration[];
  readonly table: readonly {
    readonly workflowId: string;
    readonly functionName: string;
  }[];
  readonly workflows: Readonly<Record<string, WorkflowFunction | undefined>>;
  readonly handler: WorkflowHandler;
  readonly loadBundle?: WorkflowBundleLoader;
}) {
  const functions = Object.fromEntries(
    settings.table.map((row) => [
      row.workflowId,
      settings.workflows[row.functionName],
    ]),
  );
  const registry = workflowRegistry(settings.registrations, {
    workflowBundles: {
      directory: join(settings.directory, "workflow-bundles"),
      repository: settings.repository,
    },
  });
  const resolve = async (manifest: ExecutionManifest | undefined) => {
    if (manifest === undefined) return undefined;
    const registered = registry.byPin(workflowPin(manifest));
    if (registered !== undefined) {
      const workflow = functions[registered.workflowId];
      return workflow === undefined
        ? undefined
        : { workflow, handler: settings.handler };
    }
    if (
      manifest.bundleDigest === undefined ||
      settings.loadBundle === undefined
    )
      return undefined;
    const directory = await registry.bundle(manifest);
    if (directory === undefined) return undefined;
    try {
      const generation = await settings.loadBundle(directory);
      const workflow = Object.values(generation.workflows).find(
        (candidate): candidate is WorkflowFunction =>
          typeof candidate === "function" &&
          Reflect.get(candidate, "workflowId") === manifest.workflowId,
      );
      return workflow === undefined
        ? undefined
        : { workflow, handler: generation.handler };
    } catch {
      return undefined;
    }
  };
  return {
    resolve,
    available: async (manifest: ExecutionManifest) =>
      (await resolve(manifest)) === undefined ? undefined : manifest,
  };
}

export async function prepareWorkflowGenerations(
  ports: {
    readonly state: HostPorts["state"];
    readonly workflow: Pick<HostPorts["workflow"], "manifest">;
  },
  generations: Pick<ReturnType<typeof workflowGenerations>, "resolve">,
): Promise<void> {
  const prepared = new Set<string>();
  for (const run of Object.values((await ports.state()).runs)) {
    if (
      ["completed", "failed", "cancelled"].includes(run.status) ||
      prepared.has(run.workflow)
    )
      continue;
    prepared.add(run.workflow);
    await generations.resolve(await ports.workflow.manifest(run.runId));
  }
}
