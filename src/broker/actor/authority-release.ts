import type { Database, SolidObjectsRuntime } from "solid-objects";
import { deliverEffect } from "./authority-actor.ts";
import type { deliveryHandler } from "./authority-delivery.ts";

export interface DeliveryRegistration {
  readonly runtime: SolidObjectsRuntime;
  readonly database: Database;
  readonly handle: ReturnType<typeof deliveryHandler>;
  readonly shutdownMilliseconds: number;
}

export interface TrackedDelivery {
  readonly stop: () => Promise<void>;
  readonly deliveriesInFlight: () => number;
}

export function trackedDelivery(
  registration: DeliveryRegistration,
): TrackedDelivery {
  const { runtime, database, handle, shutdownMilliseconds } = registration;
  const handlers = new Set<Promise<unknown>>();
  runtime.registerEffect(deliverEffect, (argumentsValue, context) =>
    tracked(handlers, handle(argumentsValue, context)),
  );
  let released: Promise<void> | undefined;
  return {
    deliveriesInFlight: () => handlers.size,
    stop: () => {
      const libraryWaited = released === undefined && handlers.size > 0;
      released ??= Promise.allSettled([...handlers]).then(async () => {
        await runtime.close();
        await database.close();
      });
      return releasedWithin({
        released,
        handlers,
        milliseconds: libraryWaited ? 0 : shutdownMilliseconds,
      });
    },
  };
}

function tracked<T>(
  handlers: Set<Promise<unknown>>,
  handling: Promise<T>,
): Promise<T> {
  handlers.add(handling);
  const remove = (): void => {
    handlers.delete(handling);
  };
  void handling.then(remove, remove);
  return handling;
}

async function releasedWithin(waiting: {
  readonly released: Promise<void>;
  readonly handlers: ReadonlySet<Promise<unknown>>;
  readonly milliseconds: number;
}): Promise<void> {
  const { released, handlers, milliseconds } = waiting;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `authority-close-timeout: in-flight delivery handlers: ${String(handlers.size)}`,
        ),
      );
    }, milliseconds);
  });
  try {
    await Promise.race([released, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
