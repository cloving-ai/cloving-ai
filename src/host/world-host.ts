import { getWorld } from "workflow/runtime";

export type WorkflowHandler = (request: Request) => Promise<Response>;

export interface HostSettings {
  readonly dataDirectory: string;
  readonly concurrency: number;
  readonly handler: WorkflowHandler;
}

export interface WorkflowHost {
  readonly close: () => Promise<void>;
}

export interface HostRefusal {
  readonly kind: "refused";
  readonly reason: string;
  readonly detail: string;
}

export type HostOpening =
  { readonly kind: "started"; readonly host: WorkflowHost } | HostRefusal;

const workflowQueue = "__wkf_workflow_";

interface DirectWorld {
  readonly registerHandler: (
    prefix: typeof workflowQueue,
    handler: WorkflowHandler,
  ) => void;
}

function direct<Candidate extends object>(
  world: Candidate,
): world is Candidate & DirectWorld {
  return (
    "registerHandler" in world && typeof world.registerHandler === "function"
  );
}

function refused(reason: string, detail: string): HostRefusal {
  return { kind: "refused", reason, detail };
}

function unsuitable(settings: HostSettings): HostRefusal | undefined {
  const { concurrency, dataDirectory } = settings;
  if (!Number.isInteger(concurrency) || concurrency < 1)
    return refused("invalid-host-bound", String(concurrency));
  if (process.env["WORKFLOW_TARGET_WORLD"] !== "local")
    return refused("host-world", "WORKFLOW_TARGET_WORLD is not local");
  if (process.env["WORKFLOW_LOCAL_DATA_DIR"] !== dataDirectory)
    return refused("host-world", "WORKFLOW_LOCAL_DATA_DIR is not the setting");
  if (process.env["WORKFLOW_LOCAL_QUEUE_CONCURRENCY"] !== String(concurrency))
    return refused(
      "host-bound",
      "WORKFLOW_LOCAL_QUEUE_CONCURRENCY is not the setting",
    );
  return undefined;
}

export async function startHost(settings: HostSettings): Promise<HostOpening> {
  const refusal = unsuitable(settings);
  if (refusal) return refusal;
  const world = await getWorld();
  if (!direct(world))
    return refused("host-world", "the World takes no handler in its process");
  world.registerHandler(workflowQueue, settings.handler);
  await world.start?.();
  return {
    kind: "started",
    host: {
      close: async () => {
        await world.close?.();
      },
    },
  };
}
