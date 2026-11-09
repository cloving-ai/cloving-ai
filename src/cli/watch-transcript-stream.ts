import type { TranscriptEntry } from "../turn-transcript.ts";
import type { ApiReply } from "./watch-api-problem.ts";
import type {
  ApiTranscriptPage,
  TranscriptFeed,
} from "./watch-api-transcript.ts";
import type { WatchStream } from "./watch-stream.ts";

export const transcriptPollMilliseconds = 1000;

type Listener = () => void;

interface StreamRequest {
  readonly once: (event: "close", listener: Listener) => unknown;
  readonly off: (event: "close", listener: Listener) => unknown;
}

interface StreamResponse {
  readonly writeHead: (
    status: number,
    headers: Readonly<Record<string, string>>,
  ) => unknown;
  readonly write: (chunk: string) => boolean;
  readonly once: (event: "drain", listener: Listener) => unknown;
  readonly off: (event: "drain", listener: Listener) => unknown;
  readonly end: () => unknown;
}

interface Exchange {
  readonly request: StreamRequest;
  readonly response: StreamResponse;
  readonly stream: WatchStream;
}

interface Link {
  closed: boolean;
  wake: Listener;
}

const noWake: Listener = () => undefined;

function entryMessage(entry: TranscriptEntry): string {
  return `id: ${String(entry.position)}\nevent: entry\ndata: ${JSON.stringify(entry)}\n\n`;
}

function waited(link: Link, hold: (done: Listener) => Listener): Promise<void> {
  return new Promise((settle) => {
    const release = hold(done);
    link.wake = done;
    function done(): void {
      release();
      link.wake = noWake;
      settle();
    }
  });
}

function changed(exchange: Exchange, link: Link): Promise<void> {
  return waited(link, (done) => {
    const timer = setTimeout(done, transcriptPollMilliseconds);
    const unsubscribe = exchange.stream.subscribe(done);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  });
}

function drained(exchange: Exchange, link: Link): Promise<void> {
  const { response } = exchange;
  return waited(link, (done) => {
    response.once("drain", done);
    return () => {
      response.off("drain", done);
    };
  });
}

function isRefusal(
  value: ApiTranscriptPage | ApiReply | null,
): value is ApiReply {
  return value !== null && "body" in value;
}

interface Following {
  readonly ends: Exchange;
  readonly link: Link;
}

async function paused(
  following: Following,
  page: { readonly empty: boolean; readonly full: boolean },
): Promise<void> {
  const { ends, link } = following;
  if (page.full && !link.closed) await drained(ends, link);
  if (page.empty && !link.closed) await changed(ends, link);
}

async function pages(feed: TranscriptFeed, exchange: Following): Promise<void> {
  const { ends, link } = exchange;
  const { response } = ends;
  let page: ApiTranscriptPage = feed.first;
  for (;;) {
    const writes = page.entries.map((entry) =>
      response.write(entryMessage(entry)),
    );
    if (page.entries.length === 0 && !page.open) {
      response.write(
        `event: end\ndata: ${JSON.stringify({ nextAfter: page.nextAfter })}\n\n`,
      );
      return;
    }
    await paused(exchange, {
      empty: page.entries.length === 0,
      full: writes.includes(false),
    });
    if (link.closed) return;
    const next = await feed.read(page.nextAfter);
    if (isRefusal(next)) {
      response.write(`event: refused\ndata: ${next.body}\n\n`);
      return;
    }
    page = next ?? { ...page, entries: [] };
  }
}

async function followed(
  feed: TranscriptFeed,
  exchange: Exchange,
): Promise<void> {
  const link: Link = { closed: false, wake: noWake };
  const closed = (): void => {
    link.closed = true;
    link.wake();
  };
  exchange.request.once("close", closed);
  try {
    await pages(feed, { ends: exchange, link });
  } finally {
    exchange.request.off("close", closed);
  }
}

export function transcriptStreamed(
  feed: TranscriptFeed,
  exchange: Exchange,
): void {
  exchange.response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  });
  const ended = (): void => {
    exchange.response.end();
  };
  followed(feed, exchange).then(ended, ended);
}
