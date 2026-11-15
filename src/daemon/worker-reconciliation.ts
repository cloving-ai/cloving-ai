import type { AdapterOutcome } from "../broker/actor/delivery-intents.ts";

interface StopRequest {
  readonly cancelPending?: boolean;
  readonly record?: () => Promise<void>;
  readonly perform: () => Promise<AdapterOutcome>;
}

interface Pending {
  readonly stopping?: true;
  readonly controller: AbortController;
  readonly promise: Promise<AdapterOutcome>;
}

export class WorkerReconciliation {
  private readonly pending = new Map<string, Pending>();

  run(
    key: string,
    request: {
      readonly signal: AbortSignal;
      readonly perform: (signal: AbortSignal) => Promise<AdapterOutcome>;
    },
  ): Promise<AdapterOutcome> {
    const known = this.pending.get(key);
    if (known !== undefined) return known.promise;
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    return this.track(key, { controller, promise: request.perform(signal) });
  }

  stop(key: string, request: StopRequest): Promise<AdapterOutcome> {
    const known = this.pending.get(key);
    if (known?.stopping === true) return known.promise;
    if (request.cancelPending === true) known?.controller.abort();
    return this.track(key, {
      controller: new AbortController(),
      stopping: true,
      promise: stoppedRequest(known, request),
    });
  }

  private track(key: string, entry: Pending): Promise<AdapterOutcome> {
    const promise = entry.promise.finally(() => {
      if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
    });
    this.pending.set(key, { ...entry, promise });
    return promise;
  }
}

async function stoppedRequest(
  known: Pending | undefined,
  request: StopRequest,
): Promise<AdapterOutcome> {
  await request.record?.();
  await known?.promise.catch(() => undefined);
  return request.perform();
}
