import type { DailyNumbers } from "../report-days.ts";
import type { WatchModel, WatchRepository, WatchTile } from "./watch-render.ts";

export interface WorkspacePart {
  readonly name: string;
  readonly model: WatchModel;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function addedDays(numbers: readonly DailyNumbers[]): DailyNumbers["days"] {
  const days = new Map<string, number>();
  for (const day of numbers.flatMap((today) => today.days))
    days.set(day.date, (days.get(day.date) ?? 0) + day.completed);
  return [...days]
    .toSorted(([first], [second]) => (first < second ? -1 : 1))
    .map(([date, completed]) => ({ date, completed }));
}

function workspaceToday(
  numbers: readonly DailyNumbers[],
): DailyNumbers | undefined {
  if (numbers.length === 0) return undefined;
  const costUsd = sum(numbers.map((today) => today.costUsd));
  const known = sum(numbers.map((today) => today.knownCostCompleted));
  return {
    completed: sum(numbers.map((today) => today.completed)),
    stopped: sum(numbers.map((today) => today.stopped)),
    costUsd,
    unknownCostRuns: sum(numbers.map((today) => today.unknownCostRuns)),
    knownCostCompleted: known,
    costPerCompletedRunUsd: known === 0 ? null : costUsd / known,
    yesterday: {
      completed: sum(numbers.map((today) => today.yesterday.completed)),
      costUsd: sum(numbers.map((today) => today.yesterday.costUsd)),
      unknownCostRuns: sum(
        numbers.map((today) => today.yesterday.unknownCostRuns),
      ),
    },
    days: addedDays(numbers),
    workflows: [],
  };
}

function newest(first: WatchTile, second: WatchTile): number {
  return Date.parse(second.completedAt) - Date.parse(first.completedAt);
}

function repositoryOf(part: WorkspacePart): WatchRepository {
  const { name, model } = part;
  return {
    name,
    service: model.service,
    ...(model.today === undefined ? {} : { today: model.today }),
  };
}

export function workspaceModel(parts: readonly WorkspacePart[]): WatchModel {
  const today = workspaceToday(parts.flatMap(({ model }) => model.today ?? []));
  const queues = parts.flatMap(({ name, model }) =>
    (model.queues ?? (model.queue === undefined ? [] : [model.queue])).map(
      (queue) => ({ ...queue, repository: name }),
    ),
  );
  return {
    ...(queues.length === 0 ? {} : { queues }),
    repositories: parts.map(repositoryOf),
    updatedAt: parts.reduce(
      (latest, { model }) =>
        model.updatedAt > latest ? model.updatedAt : latest,
      "",
    ),
    service: parts.every(({ model }) => model.service === "up") ? "up" : "down",
    workflows: parts.flatMap(({ name, model }) =>
      model.workflows.map((workflow) => ({ ...workflow, repository: name })),
    ),
    runs: parts.flatMap(({ name, model }) =>
      model.runs.map((run) => ({ ...run, repository: name })),
    ),
    completed: parts
      .flatMap(({ model }) => model.completed ?? [])
      .toSorted(newest),
    workflowRefusals: parts.flatMap(
      ({ model }) => model.workflowRefusals ?? [],
    ),
    cardForms: [],
    ...(today === undefined ? {} : { today }),
  };
}
