import type { DevelopTask } from "./report.ts";
import type { DevelopLessons } from "./turn.ts";

export type LessonsMode = "file" | "none";

export const lessons = "file" as LessonsMode;

export function lessonsPayload(mode: LessonsMode): string {
  return mode === "file" ? JSON.stringify({ lessons: true }) : "{}";
}

export function lessonsTask(request: {
  readonly task: DevelopTask;
  readonly mode: LessonsMode;
  readonly result: string | null;
}): DevelopTask {
  const { task, mode, result } = request;
  if (mode === "none") return task;
  return {
    cycleId: task.cycleId,
    repository: task.repository,
    ticket: task.ticket,
    issue: task.issue,
    lessons: lessonsOf(result),
  };
}

function lessonsOf(result: string | null): DevelopLessons {
  const value: unknown = JSON.parse(result ?? "null");
  const read: unknown =
    typeof value === "object" && value !== null && "lessons" in value
      ? value.lessons
      : null;
  if (!validLessons(read)) throw new Error("invalid-lessons");
  return { text: read.text, bytes: read.bytes };
}

function validLessons(value: unknown): value is DevelopLessons {
  return (
    typeof value === "object" &&
    value !== null &&
    "text" in value &&
    typeof value.text === "string" &&
    "bytes" in value &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0
  );
}
