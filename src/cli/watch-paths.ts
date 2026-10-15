import { basename } from "node:path";
import type { WatchRun, WatchTurn } from "./watch-render.ts";

function folderPattern(folder: string): RegExp {
  const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![^\\s'"\`([{<,:;=])${escaped}(?=$|[/\\s'"),:;]|\\.(?=\\s|$))`,
    "g",
  );
}

function homePaths(text: string, home: string): string {
  if (home === "") return text;
  return text.replace(folderPattern(home), "~");
}

function relativePath(path: string, following: string): string {
  if (!path.endsWith("/")) return ".";
  return /^(?:$|[\s'"),:;]|\.(?=\s|$))/.test(following) ? "." : "";
}

function turnPaths(
  turn: WatchTurn,
  shown: (text: string) => string,
): WatchTurn {
  return {
    ...turn,
    worktree: basename(turn.worktree),
    activity: turn.activity.map((item) => ({
      ...item,
      text: shown(item.text),
    })),
    summary: shown(turn.summary),
    commits: turn.commits.map(shown),
    files: turn.files.map(shown),
    uncommitted: turn.uncommitted.map(shown),
  };
}

export function displayRun(run: WatchRun, home: string): WatchRun {
  const worktrees = [...new Set(run.turns.map((turn) => turn.worktree))]
    .filter((folder) => folder !== "")
    .toSorted((left, right) => right.length - left.length)
    .map((folder) => new RegExp(`${folderPattern(folder).source}/?`, "g"));
  const shown = (text: string): string =>
    homePaths(
      worktrees.reduce(
        (value, pattern) =>
          value.replace(pattern, (path, offset: number) =>
            relativePath(path, value.slice(offset + path.length)),
          ),
        text,
      ),
      home,
    );
  return {
    ...run,
    title: run.title === null ? null : shown(run.title),
    detail: shown(run.detail),
    turns: run.turns.map((turn) => turnPaths(turn, shown)),
    decisions: run.decisions.map((decision) => ({
      ...decision,
      prompt: shown(decision.prompt),
      approve: homePaths(decision.approve, home),
      deny: homePaths(decision.deny, home),
    })),
    feedback: run.feedback.map((feedback) => ({
      ...feedback,
      text: shown(feedback.text),
    })),
  };
}
