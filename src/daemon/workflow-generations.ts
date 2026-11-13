import { join } from "node:path";
import type { HostPorts } from "../service/service.ts";
import type { WorkflowFunction } from "../host/start-delivery.ts";
import type { WorkflowHandler } from "../host/world-host.ts";
import type { ExecutionManifest } from "../workflow-admission.ts";
import {
  workflowRegistry,
  type WorkflowBundleStore,
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

export interface CurrentGeneration {
  readonly registrations: readonly WorkflowRegistration[];
  readonly table: readonly {
    readonly workflowId: string;
    readonly functionName: string;
  }[];
  readonly workflows: Readonly<Record<string, unknown>>;
  readonly handler: WorkflowHandler;
}

function isWorkflowFunction(value: unknown): value is WorkflowFunction {
  return typeof value === "function";
}

function workflowGeneration(
  source: CurrentGeneration,
  workflowBundles: WorkflowBundleStore,
) {
  return {
    functions: new Map(
      source.table.map((row) => [
        row.workflowId,
        source.workflows[row.functionName],
      ]),
    ),
    feeds: new Map(
      source.registrations.flatMap(({ feed, availability }) =>
        feed === undefined || availability !== "available"
          ? []
          : [[workflowPin(feed.manifest), source.workflows[feed.functionName]]],
      ),
    ),
    registry: workflowRegistry(source.registrations, { workflowBundles }),
    handler: source.handler,
  };
}

function currentWorkflow(
  generation: ReturnType<typeof workflowGeneration>,
  pin: string,
): { readonly workflow: unknown } | undefined {
  if (generation.feeds.has(pin)) return { workflow: generation.feeds.get(pin) };
  const registered = generation.registry.byPin(pin);
  if (registered === undefined) return undefined;
  return { workflow: generation.functions.get(registered.workflowId) };
}

export function workflowGenerations(
  settings: CurrentGeneration & {
    readonly directory: string;
    readonly repository: string;
    readonly loadBundle?: WorkflowBundleLoader;
  },
) {
  const workflowBundles = {
    directory: join(settings.directory, "workflow-bundles"),
    repository: settings.repository,
  };
  let current = workflowGeneration(settings, workflowBundles);
  const resolve = async (manifest: ExecutionManifest | undefined) => {
    if (manifest === undefined) return undefined;
    const { registry, handler } = current;
    const found = currentWorkflow(current, workflowPin(manifest));
    if (found !== undefined) {
      const { workflow } = found;
      return isWorkflowFunction(workflow) ? { workflow, handler } : undefined;
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
          isWorkflowFunction(candidate) &&
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
    replace: (source: CurrentGeneration) => {
      current = workflowGeneration(source, workflowBundles);
    },
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
