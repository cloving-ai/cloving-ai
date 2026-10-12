import { setTimeout as delay } from "node:timers/promises";
import type { Database, SolidObjectsRuntime } from "solid-objects";
import { deliverEffect } from "./authority-actor.ts";
import type { deliveryHandler } from "./authority-delivery.ts";

export interface DeliveryRegistration {
  readonly runtime: Pick<SolidObjectsRuntime, "registerEffect" | "close">;
  readonly database: Pick<Database, "close">;
  readonly handle: ReturnType<typeof deliveryHandler>;
  readonly shutdownMilliseconds: number;
}

export interface TrackedDelivery {
  readonly stop: () => Promise<void>;
  readonly handlersSettled: () => Promise<boolean>;
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
    handlersSettled: async () => {
      await settledWithin([...handlers], shutdownMilliseconds);
      return handlers.size === 0;
    },
    stop: () => {
      const libraryWaited = released === undefined && handlers.size > 0;
      released ??= Promise.allSettled([...handlers]).then(() =>
        closedInOrder([() => runtime.close(), () => database.close()]),
      );
      return releasedWithin({
        released,
        handlers,
        milliseconds: libraryWaited ? 0 : shutdownMilliseconds,
      });
    },
  };
}

async function closedInOrder(
  closers: readonly (() => Promise<void>)[],
): Promise<void> {
  const attempts: Promise<void>[] = [];
  for (const close of closers) {
    const attempt = close();
    attempts.push(attempt);
    await attempt.catch(() => undefined);
  }
  await Promise.all(attempts);
}

async function settledWithin(
  handlers: readonly Promise<unknown>[],
  milliseconds: number,
): Promise<void> {
  if (handlers.length === 0) return;
  const limit = new AbortController();
  try {
    await Promise.race([
      Promise.allSettled(handlers),
      delay(milliseconds, undefined, { signal: limit.signal }).catch(
        () => undefined,
      ),
    ]);
  } finally {
    limit.abort();
  }
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
