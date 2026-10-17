import type { PrObserver } from "./watch-pr-observer.ts";
import type { WatchCard, WatchModel } from "./watch-render.ts";

function observedCard(
  context: { readonly model: WatchModel; readonly observer: PrObserver },
  card: WatchCard,
): WatchCard {
  if (card.completionMark?.text !== "Needs attention") return card;
  const run = context.model.runs.find((run) => run.runId === card.runId);
  if (
    run?.workflowId !== "develop-issue" ||
    run.state !== "completed" ||
    run.outcome !== "blocked" ||
    run.pullRequest === null
  )
    return card;
  return {
    ...card,
    pullRequestObservation: context.observer.observe(run.pullRequest),
  };
}

export function observedBoard(
  model: WatchModel,
  observer: PrObserver,
): WatchModel {
  return {
    ...model,
    workflows: model.workflows.map((workflow) => ({
      ...workflow,
      columns: workflow.columns.map((column) => ({
        ...column,
        cards: column.cards.map((card) =>
          observedCard({ model, observer }, card),
        ),
      })),
    })),
  };
}
