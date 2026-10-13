import type {
  Delivery,
  DeliveryIntent,
} from "../broker/actor/delivery-intents.ts";
import type { StartDelivery } from "../host/start-delivery.ts";

export interface DeliveryRoutes {
  readonly runs: StartDelivery;
  readonly effects: Delivery & { readonly stop: NonNullable<Delivery["stop"]> };
}

function protectedEffect(intent: DeliveryIntent): boolean {
  return intent.kind === "protected-effect";
}

export function deliveryRouter(routes: DeliveryRoutes): Delivery {
  const { runs, effects } = routes;
  return {
    deliver: (intent, signal) =>
      protectedEffect(intent)
        ? effects.deliver(intent, signal)
        : runs.deliver(intent),
    reconcile: (intent, signal) =>
      protectedEffect(intent)
        ? effects.reconcile(intent, signal)
        : runs.reconcile(intent),
    stop: (intent, signal) =>
      protectedEffect(intent)
        ? effects.stop(intent, signal)
        : runs.stop(intent),
  };
}
