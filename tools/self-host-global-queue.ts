import type { GlobalQueueLimits } from "../src/queue-room.ts";
import type { QueueSource } from "../src/queue-settings.ts";
import type { SettingSource } from "../src/project-settings.ts";
type Environment = Readonly<Record<string, string | undefined>>;

function refusedStart(code: string): never {
  throw new Error(`The daemon did not start: ${code}`);
}

function laneSetting(
  text: string | undefined,
  reason: string,
): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (
    !/^\d+$/.test(text) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 16
  )
    refusedStart(reason);
  return value;
}

export function queueGlobalLimits(
  environment: Environment,
  sources: Readonly<Record<string, SettingSource>> = {},
): GlobalQueueLimits | undefined {
  const lanes = laneSetting(
    environment["CLOVING_QUEUE_GLOBAL_LANES"],
    "invalid-global-queue-lanes",
  );
  const workingLanes = laneSetting(
    environment["CLOVING_QUEUE_GLOBAL_WORKING_LANES"],
    "invalid-global-queue-working-lanes",
  );
  if (lanes === undefined && workingLanes === undefined) return undefined;
  if (workingLanes !== undefined && workingLanes > (lanes ?? 16))
    refusedStart("invalid-global-queue-working-lanes");
  const origin = (field: string): QueueSource => globalSource(sources[field]);
  return {
    ...(lanes === undefined ? {} : { lanes }),
    ...(workingLanes === undefined ? {} : { workingLanes }),
    sources: {
      lanes: sourcedOrigin(lanes, origin("queue.globalLanes")),
      workingLanes: sourcedOrigin(
        workingLanes,
        origin("queue.globalWorkingLanes"),
      ),
    },
  };
}

function sourcedOrigin(
  value: number | undefined,
  source: QueueSource,
): QueueSource {
  return value === undefined ? "default" : source;
}

function globalSource(source: SettingSource | undefined): QueueSource {
  if (source === "private") return "queue setting (private file)";
  if (source === "project") return "queue setting (project file)";
  return "environment";
}
