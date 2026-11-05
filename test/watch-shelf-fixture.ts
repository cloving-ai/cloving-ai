import type { GithubRecords } from "../src/cli/watch-model.ts";
import { boardRun } from "./watch-board-fixture.ts";
import { floorModel } from "./watch-floor-fixture.ts";
import { mergeJournal } from "./watch-merge-fixture.ts";

export const demoUrl = "https://github.com/user-attachments/assets/demo-475";

export function localTime(day: number, clock: string): string {
  const [hours = 0, minutes = 0] = clock.split(":").map(Number);
  return new Date(2026, 9, 14 + day, hours, minutes).toISOString();
}

export function completedRun(
  runId: string,
  options: {
    readonly createdAt: string;
    readonly completedAt: string;
    readonly workflowId?: string;
    readonly ticketId?: string;
    readonly outcome?: string;
    readonly ticketStatus?: string;
    readonly state?: string;
  },
): Record<string, unknown> {
  return boardRun(runId, {
    state: options.state ?? "completed",
    outcome: options.outcome ?? "handoff_requested",
    ...(options.ticketStatus === undefined
      ? {}
      : { ticketStatus: options.ticketStatus }),
    ticketId: options.ticketId,
    latestAt: options.completedAt,
    ...(options.workflowId === undefined
      ? {}
      : { workflowId: options.workflowId }),
    events: [
      { sequence: 1, type: "run.created", recordedAt: options.createdAt },
      { sequence: 2, type: "run.completed", recordedAt: options.completedAt },
    ],
  });
}

export function pullRecord(runId: string, number: number): GithubRecords {
  return mergeJournal(runId, {
    method: "open-pr",
    report: {
      number,
      url: `https://github.example/fixture/demo/pull/${String(number)}`,
    },
  });
}

export function attachedRecord(
  runId: string,
  attachment: {
    readonly number: number;
    readonly name: string;
    readonly url: string;
    readonly outcome?: string;
  },
): GithubRecords {
  const { started, result } = mergeJournal(runId, {
    method: "attach-asset",
    report: { number: attachment.number, url: attachment.url },
    ...(attachment.outcome === undefined
      ? {}
      : { outcome: attachment.outcome }),
  });
  return {
    started: {
      ...(typeof started === "object" ? started : {}),
      payloadText: JSON.stringify({
        number: attachment.number,
        name: attachment.name,
        release: "pr-demos",
        comment: "Demo of the change.",
      }),
    },
    result,
  };
}

export function shelfModel() {
  return floorModel(
    [
      completedRun("early", {
        ticketId: "475",
        createdAt: localTime(0, "06:16"),
        completedAt: localTime(0, "10:00"),
      }),
      completedRun("late", {
        ticketId: "477",
        createdAt: localTime(0, "09:00"),
        completedAt: localTime(0, "11:34"),
      }),
      completedRun("draft", {
        workflowId: "idea",
        createdAt: localTime(0, "10:30"),
        completedAt: localTime(0, "11:00"),
      }),
      completedRun("yesterday", {
        ticketId: "470",
        createdAt: localTime(-1, "20:00"),
        completedAt: localTime(-1, "23:59"),
      }),
    ],
    {
      updatedAt: localTime(0, "12:00"),
      githubRecords: [
        pullRecord("early", 580),
        attachedRecord("early", {
          number: 580,
          name: "demo.mp4",
          url: demoUrl,
        }),
        pullRecord("late", 577),
        pullRecord("yesterday", 571),
      ],
    },
  );
}

export const demoVideo = Buffer.from(
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAH7EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHGTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggHl7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBNgIRMYXZmV0GETGF2ZkSJiEDdTAAAAAAAFlSua9iuAQAAAAAAAE/XgQFzxYgAAAAAAAAAAZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhQJUC+QA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ7Vzc7JjwItjxYgAAAAAAAAAAWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MzAuMDAwMDAwMDAwAB9DtnWv54EAo6qBAACAMAIAnQEqEAAQAAvHCIWFiJmEiD+CAnT0b0+A/m8WygT1uIwzrAAfQ7Z1peeCJxCjn4EAAACxAQAvEfwAGAAwP/QMAO8A/m8WygT1uIwzrAAfQ7Z1peeCTiCjn4EAAACxAQAvEfwAGAAwP/QMAO8A/m8WygT1uIwzrAAcU7trkbuPs4EAt4r3gQHxggFd8IED",
  "base64",
);
