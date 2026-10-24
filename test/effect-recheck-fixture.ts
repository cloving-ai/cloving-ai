import type {
  Delivery,
  DeliveryIntent,
} from "../src/broker/actor/authority.ts";
import { later, type Destination } from "./effect-fixture.ts";

export function uncertainRetryDelivery(
  scenario: string,
  clock: { now: string },
): Delivery & { readonly available: boolean; readonly retries: number } {
  let sent = false;
  let available = true;
  let retries = 0;
  return {
    get available() {
      return available;
    },
    get retries() {
      return retries;
    },
    reconcile: () => Promise.resolve({ kind: sent ? "unknown" : "absent" }),
    deliver: (intent) => {
      if (intent.kind !== "protected-effect")
        return Promise.resolve({ kind: "unknown" });
      sent = true;
      if (scenario === "lease-expired") clock.now = later;
      if (scenario === "pin-unavailable") available = false;
      return Promise.resolve({ kind: "unknown" });
    },
    retry: () => {
      retries += 1;
      return Promise.resolve({
        kind: "completed",
        receipt: "target",
        worker: "handoff",
        result: "target",
      });
    },
  };
}

export interface Held {
  readonly delivery: Delivery;
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly sent: DeliveryIntent[];
}

export function heldReconcile(
  destination: Destination,
  kind: DeliveryIntent["kind"],
): Held {
  const entered = Promise.withResolvers<undefined>();
  const gate = Promise.withResolvers<undefined>();
  const sent: DeliveryIntent[] = [];
  let first = true;
  return {
    entered: entered.promise,
    release: () => {
      gate.resolve(undefined);
    },
    sent,
    delivery: {
      deliver: (intent, signal) => {
        sent.push(intent);
        return destination.delivery.deliver(intent, signal);
      },
      reconcile: async (intent, signal) => {
        if (intent.kind === kind && first) {
          first = false;
          entered.resolve(undefined);
          await gate.promise;
        }
        return destination.delivery.reconcile(intent, signal);
      },
    },
  };
}
