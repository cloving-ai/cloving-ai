export interface FakeAnswer {
  readonly answer_id: unknown;
  readonly device_id: unknown;
  readonly ciphertext: unknown;
  readonly sequence: number;
}

type Reply = readonly [number, unknown];

export function inboxPage(inbox: readonly FakeAnswer[], url: URL): Reply {
  const after = Number(url.searchParams.get("after") ?? 0);
  const answers = inbox.filter((item) => item.sequence > after);
  return [200, { answers, cursor: answers.at(-1)?.sequence ?? after }];
}

export function acknowledged(
  store: {
    readonly inbox: FakeAnswer[];
    readonly acked: string[];
    readonly statuses: number[];
  },
  body: unknown,
): Reply {
  const status = store.statuses.shift() ?? 200;
  if (status !== 200) return [status, null];
  const ids: unknown = Reflect.get(Object(body), "answer_ids");
  const answerIds = Array.isArray(ids) ? ids.map(String) : [];
  store.acked.push(...answerIds);
  const kept = store.inbox.filter(
    (item) => !answerIds.includes(String(item.answer_id)),
  );
  store.inbox.splice(0, store.inbox.length, ...kept);
  return [200, { acknowledged: answerIds.length }];
}

export async function inboxWait(
  inbox: readonly FakeAnswer[],
  waiting: {
    readonly url: URL;
    readonly wake: (deadline: number) => Promise<void>;
  },
): Promise<void> {
  const { url } = waiting;
  const after = Number(url.searchParams.get("after") ?? 0);
  const seconds = Number(url.searchParams.get("wait") ?? "0");
  const deadline = Date.now() + Math.min(seconds, 5) * 1000;
  while (!inbox.some((item) => item.sequence > after) && Date.now() < deadline)
    await waiting.wake(deadline);
}
