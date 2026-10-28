import { ticketStatus, type TicketStatus } from "./ticket-status.ts";

export interface StreamedTicketStatus {
  readonly ticketStatus: TicketStatus;
  readonly ticketStatusTooLarge?: true;
}

interface Line {
  text: string;
  length: number;
  contentLength: number;
  breaks: number;
  trailingCarriage: boolean;
}

function emptyLine(): Line {
  return {
    text: "",
    length: 0,
    contentLength: 0,
    breaks: 0,
    trailingCarriage: false,
  };
}

interface StatusStream {
  readonly limit: number;
  line: Line;
  last: Line | undefined;
  statuses: number;
  remaining: string[];
  characters: number;
  valid: boolean;
}

function remainingLine(stream: StatusStream, line: Line): void {
  if (line.length <= stream.limit && line.text === "Remaining:") {
    stream.remaining = [];
    stream.characters = 0;
    stream.valid = true;
    return;
  }
  if (!stream.valid) return;
  if (line.breaks > 0 || !/^- \S.*$/.test(line.text)) {
    stream.valid = false;
    return;
  }
  stream.characters = Math.min(
    stream.limit + 1,
    stream.characters + line.length + 1,
  );
  if (stream.characters <= stream.limit)
    stream.remaining.push(line.text.slice(2));
}

function receivedLine(stream: StatusStream): void {
  const line = stream.line;
  stream.line = emptyLine();
  if (line.contentLength === 0) return;
  if (line.trailingCarriage) line.breaks--;
  if (line.length <= stream.limit + 1 && line.trailingCarriage) {
    line.text = line.text.slice(0, -1);
    line.length--;
  }
  if (stream.last !== undefined) remainingLine(stream, stream.last);
  if (/^Ticket status:/i.test(line.text))
    stream.statuses = Math.min(2, stream.statuses + 1);
  stream.last = line;
}

function writeStatus(stream: StatusStream, chunk: string): void {
  const parts = chunk.split("\n");
  for (const [index, part] of parts.entries()) {
    const { line, limit } = stream;
    const content = part.trimEnd();
    line.breaks = Math.min(
      2,
      line.breaks + (part.match(/[\r\u2028\u2029]/g)?.length ?? 0),
    );
    if (part !== "") line.trailingCarriage = part.endsWith("\r");
    if (content !== "")
      line.contentLength = Math.min(limit + 1, line.length + content.length);
    line.text = (line.text + part).slice(0, limit + 1);
    line.length = Math.min(limit + 2, line.length + part.length);
    if (index < parts.length - 1) receivedLine(stream);
  }
}

function statusResult(stream: StatusStream): StreamedTicketStatus {
  receivedLine(stream);
  const last = stream.last;
  if (stream.statuses !== 1 || last === undefined)
    return { ticketStatus: ticketStatus("") };
  const status = last.contentLength > stream.limit ? "" : last.text.trimEnd();
  if (status !== "Ticket status: partial" || !stream.valid)
    return { ticketStatus: ticketStatus(status) };
  if (stream.characters > stream.limit)
    return {
      ticketStatus: ticketStatus(status),
      ticketStatusTooLarge: true,
    };
  return {
    ticketStatus: ticketStatus(
      `Remaining:\n${stream.remaining.map((item) => `- ${item}`).join("\n")}\n${status}`,
    ),
  };
}

export function ticketStatusStream(limit: number) {
  const stream: StatusStream = {
    limit,
    line: emptyLine(),
    last: undefined,
    statuses: 0,
    remaining: [],
    characters: 0,
    valid: false,
  };
  return {
    write: (chunk: string): void => {
      writeStatus(stream, chunk);
    },
    result: (): StreamedTicketStatus => statusResult(stream),
  };
}
