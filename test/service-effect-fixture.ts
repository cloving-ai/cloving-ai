import type {
  Delivery,
  EffectSettings,
} from "../src/broker/actor/authority.ts";
import type {
  EffectReply,
  EffectRequest,
  Service,
  ServiceLimits,
  ServiceOptions,
} from "../src/service/service.ts";
import { fakeDestination, type Destination } from "./effect-fixture.ts";
import {
  eventually,
  field,
  items,
  startedRun,
  type Harness,
} from "./service-fixture.ts";
import { view } from "./service-views.ts";

export const noon = "2026-10-10T12:00:00.000Z";
export const afterLease = "2026-10-10T12:10:00.000Z";

export interface Scene {
  readonly harness: Harness;
  readonly service: Service;
  readonly runId: string;
  readonly destination: Destination;
  readonly clock: { now: string };
  readonly options: Partial<ServiceOptions>;
}

export async function effectScene(
  harness: Harness,
  setup: {
    readonly effectLimit: number;
    readonly lostReplies?: number;
    readonly effects?: Partial<EffectSettings>;
    readonly reconcile?: Delivery["reconcile"];
    readonly limits?: ServiceLimits;
  },
): Promise<Scene> {
  const destination = fakeDestination({ lostReplies: setup.lostReplies ?? 0 });
  const clock = { now: noon };
  const options: Partial<ServiceOptions> = {
    workflows: [{ ...harness.registration, effectLimit: setup.effectLimit }],
    delivery: {
      ...destination.delivery,
      deliver: (intent, signal) => {
        if (intent.kind !== "protected-effect") harness.sent.push(intent);
        return destination.delivery.deliver(intent, signal);
      },
      reconcile: (intent, signal) => {
        const scripted =
          intent.kind === "protected-effect" ? setup.reconcile : undefined;
        return (scripted ?? destination.delivery.reconcile)(intent, signal);
      },
    },
    clock: () => clock.now,
    ...(setup.effects === undefined ? {} : { effects: setup.effects }),
    ...(setup.limits === undefined ? {} : { limits: setup.limits }),
  };
  const service = await harness.start(options);
  const runId = await startedRun(harness, { service, commandId: "c-1" });
  return { harness, service, runId, destination, clock, options };
}

export function requested(
  scene: Scene,
  request: Partial<EffectRequest> & {
    readonly commandId: string;
    readonly round: number;
  },
): Promise<EffectReply> {
  const { round, ...rest } = request;
  return scene.service.worker.requestEffect({
    runId: scene.runId,
    scope: { phase: "work", operation: "effect", round },
    capability: "fake-harness",
    method: "run-turn",
    target: "workspace/main",
    payload: "build the package",
    units: 1,
    ...rest,
  });
}

export async function shownEffects(scene: Scene): Promise<readonly unknown[]> {
  return items(field(await view(scene.harness, scene.runId), "effects"));
}

export async function effectStates(scene: Scene): Promise<readonly unknown[]> {
  return (await shownEffects(scene)).map((effect) => field(effect, "state"));
}

export async function untilStates(
  scene: Scene,
  expected: readonly string[],
): Promise<void> {
  const wanted = JSON.stringify(expected);
  await eventually(async () =>
    JSON.stringify(await effectStates(scene)) === wanted ? true : undefined,
  );
}

export function dispatches(scene: Scene): number {
  return scene.destination.calls.filter((call) => call.startsWith("deliver"))
    .length;
}
