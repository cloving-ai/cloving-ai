export type CallResult<Reply> =
  | { readonly kind: "replied"; readonly reply: Reply }
  | { readonly kind: "thrown"; readonly message: string }
  | { readonly kind: "overdue" };

export interface AdapterCalls {
  readonly call: <Reply>(
    operationId: string,
    invoke: (signal: AbortSignal) => Promise<Reply>,
  ) => Promise<CallResult<Reply>>;
}

interface OpenCall {
  settled: boolean;
}

function attempted<Reply>(
  invoke: (signal: AbortSignal) => Promise<Reply>,
  signal: AbortSignal,
): Promise<CallResult<Reply>> {
  return Promise.resolve()
    .then(() => invoke(signal))
    .then(
      (reply): CallResult<Reply> => ({ kind: "replied", reply }),
      (error: unknown): CallResult<Reply> => ({
        kind: "thrown",
        message: String(Reflect.get(Object(error), "message")),
      }),
    );
}

export function adapterCalls(milliseconds: number): AdapterCalls {
  const overdue = new Map<string, OpenCall>();
  return {
    call: async (operationId, invoke) => {
      if (overdue.get(operationId)?.settled === false)
        return { kind: "overdue" };
      const limit = new AbortController();
      const open: OpenCall = { settled: false };
      const attempt = attempted(invoke, limit.signal).then((result) => {
        open.settled = true;
        return result;
      });
      const expiry = Promise.withResolvers<{ readonly kind: "overdue" }>();
      const timer = setTimeout(() => {
        expiry.resolve({ kind: "overdue" });
      }, milliseconds);
      const result = await Promise.race([attempt, expiry.promise]);
      clearTimeout(timer);
      if (result.kind !== "overdue") return result;
      limit.abort();
      overdue.set(operationId, open);
      return result;
    },
  };
}
