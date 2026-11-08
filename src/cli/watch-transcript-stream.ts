import type { IncomingMessage, ServerResponse } from "node:http";
import type { TranscriptEntry } from "../turn-transcript.ts";
import type {
  ApiTranscriptPage,
  TranscriptFeed,
} from "./watch-api-transcript.ts";
import type { WatchStream } from "./watch-stream.ts";

export const transcriptPollMilliseconds = 1000;

interface Exchange {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly stream: WatchStream;
}

function entryMessage(entry: TranscriptEntry): string {
  return `id: ${String(entry.position)}\nevent: entry\ndata: ${JSON.stringify(entry)}\n\n`;
}

function changed(exchange: Exchange, closed: Promise<void>): Promise<void> {
  return new Promise((settle) => {
    const timer = setTimeout(done, transcriptPollMilliseconds);
    const unsubscribe = exchange.stream.subscribe(done);
    closed.then(done, done);
    function done(): void {
      clearTimeout(timer);
      unsubscribe();
      settle();
    }
  });
}

async function followed(
  feed: TranscriptFeed,
  exchange: Exchange,
): Promise<void> {
  const { request, response } = exchange;
  const ended = { value: false };
  const closed = new Promise<void>((settle) => {
    request.once("close", () => {
      ended.value = true;
      settle();
    });
  });
  let page: ApiTranscriptPage = feed.first;
  for (;;) {
    for (const entry of page.entries) response.write(entryMessage(entry));
    if (page.entries.length === 0 && !page.open) {
      response.end(
        `event: end\ndata: ${JSON.stringify({ nextAfter: page.nextAfter })}\n\n`,
      );
      return;
    }
    if (page.entries.length === 0) await changed(exchange, closed);
    if (ended.value) return;
    page = (await feed.read(page.nextAfter)) ?? { ...page, entries: [] };
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
  followed(feed, exchange).then(
    () => undefined,
    () => {
      exchange.response.end();
    },
  );
}
