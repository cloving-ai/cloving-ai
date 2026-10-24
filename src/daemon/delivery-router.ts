import type {
  AdapterOutcome,
  Delivery,
  DeliveryIntent,
} from "../broker/actor/delivery-intents.ts";
import type { StartDelivery } from "../host/start-delivery.ts";

export type EffectDelivery = Delivery & {
  readonly stop: NonNullable<Delivery["stop"]>;
};

export interface DeliveryRoutes {
  readonly runs: StartDelivery;
  readonly effects: Readonly<Record<string, EffectDelivery>>;
}

const refused: AdapterOutcome = {
  kind: "failed",
  reason: "unsupported-effect",
};

function protectedEffect(intent: DeliveryIntent): boolean {
  return intent.kind === "protected-effect";
}

function workerOf(
  routes: DeliveryRoutes,
  intent: DeliveryIntent,
): EffectDelivery | undefined {
  const capability = String(intent.capability);
  return Object.hasOwn(routes.effects, capability)
    ? routes.effects[capability]
    : undefined;
}

export function deliveryRouter(routes: DeliveryRoutes): Delivery {
  const { runs } = routes;
  const refusal = (): Promise<AdapterOutcome> => Promise.resolve(refused);
  return {
    deliver: (intent, signal) => {
      if (!protectedEffect(intent)) return runs.deliver(intent);
      return workerOf(routes, intent)?.deliver(intent, signal) ?? refusal();
    },
    reconcile: (intent, signal) => {
      if (!protectedEffect(intent)) return runs.reconcile(intent);
      return workerOf(routes, intent)?.reconcile(intent, signal) ?? refusal();
    },
    retry: (intent, signal) => {
      if (!protectedEffect(intent)) return refusal();
      return (
        workerOf(routes, intent)?.retry?.(intent, signal) ??
        Promise.resolve({ kind: "unknown" })
      );
    },
    stop: (intent, signal) => {
      if (!protectedEffect(intent)) return runs.stop(intent);
      return workerOf(routes, intent)?.stop(intent, signal) ?? refusal();
    },
  };
}
