import type { Reply } from "../protocol.ts";

export type AdmissionLock = (
  keys: readonly string[],
  next: () => Promise<Reply>,
) => Promise<Reply>;

export function admissionLock(): AdmissionLock {
  const pending = new Map<string, Promise<Reply>>();
  return (keys, next) => {
    const previous = keys
      .map((key) => pending.get(key))
      .filter((reply) => reply !== undefined);
    const reply = Promise.allSettled(previous).then(next);
    for (const key of keys) pending.set(key, reply);
    const settled = (): void => {
      for (const key of keys)
        if (pending.get(key) === reply) pending.delete(key);
    };
    reply.then(settled, settled);
    return reply;
  };
}

export function admissionKeys(admission: {
  readonly commandId: string;
  readonly workflowId: string;
  readonly queue?: boolean;
}): string[] {
  return [
    `command:${admission.commandId}`,
    `workflow:${admission.workflowId}`,
    ...(admission.queue === true ? ["repository:queues"] : []),
  ];
}
