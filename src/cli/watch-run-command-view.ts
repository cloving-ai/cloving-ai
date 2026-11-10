import { component, element, type Shown } from "./watch-element.ts";
import type { WatchCard, WatchRun } from "./watch-render.ts";
import type { RunCommand } from "./runtime-invocation.ts";
import {
  SteerAction,
  steerable,
  type SteerControls,
} from "./watch-steer-view.ts";

export interface RunCommandControls {
  readonly busy: readonly string[];
  readonly messages: Readonly<Record<string, string>>;
  readonly asking: string | null;
  readonly onCommand: (runId: string, command: RunCommand) => void;
  readonly onAsk: (runId: string) => void;
  readonly onKeep: () => void;
}

interface RunCommandProps {
  readonly runId: string;
  readonly paused: boolean;
  readonly controlling: RunCommandControls | undefined;
}

export function RunCommandButtons(
  props: RunCommandProps & { readonly controlling: RunCommandControls },
): Shown {
  const { runId, paused, controlling } = props;
  const busy = controlling.busy.includes(runId) ? { disabled: true } : {};
  const command = paused ? "resume" : "pause";
  return [
    element("button", {
      type: "button",
      class: `run-command-${command}`,
      ...busy,
      onClick: () => {
        controlling.onCommand(runId, command);
      },
      children: paused ? "Resume" : "Pause",
    }),
    element("button", {
      type: "button",
      class: "run-command-drop",
      ...busy,
      onClick: () => {
        controlling.onAsk(runId);
      },
      children: "Drop",
    }),
  ];
}

export function DropQuestion(props: {
  readonly runId: string;
  readonly controlling: RunCommandControls;
}): Shown {
  const { runId, controlling } = props;
  return element("p", {
    class: "drop-question",
    children: [
      element("span", {
        children: "Drop this run? Its work tree and pull request stay.",
      }),
      " ",
      element("button", {
        type: "button",
        class: "drop-confirm",
        ...(controlling.busy.includes(runId) ? { disabled: true } : {}),
        onClick: () => {
          controlling.onCommand(runId, "drop");
        },
        children: "Drop the run",
      }),
      " ",
      element("button", {
        type: "button",
        class: "drop-keep",
        onClick: controlling.onKeep,
        children: "Keep it",
      }),
    ],
  });
}

export function RunCommandAction(props: RunCommandProps): Shown {
  const { runId, paused, controlling } = props;
  if (controlling === undefined) return null;
  const message = controlling.messages[runId];
  return element("div", {
    class: "run-command",
    "data-run": runId,
    children: [
      controlling.asking === runId
        ? component(DropQuestion, { runId, controlling })
        : component(RunCommandButtons, { runId, paused, controlling }),
      message === undefined
        ? null
        : element("p", {
            class: "run-command-message",
            role: "status",
            children: message,
          }),
    ],
  });
}

export function RunCommandMenu(props: RunCommandProps): Shown {
  if (props.controlling === undefined) return null;
  return element("details", {
    class: "run-menu",
    children: [
      element("summary", {
        title: "Run controls",
        children: [
          element("span", { "aria-hidden": "true", children: "⋯" }),
          element("span", {
            class: "visually-hidden",
            children: "Run controls",
          }),
        ],
      }),
      component(RunCommandAction, props),
    ],
  });
}

export function RunActions(props: {
  readonly run: Pick<WatchRun, "runId" | "state">;
  readonly steering: SteerControls | undefined;
  readonly controlling: RunCommandControls | undefined;
}): Shown {
  const { run } = props;
  if (!steerable(run.state)) return null;
  return [
    component(SteerAction, { runId: run.runId, steering: props.steering }),
    component(RunCommandAction, {
      runId: run.runId,
      paused: run.state === "paused",
      controlling: props.controlling,
    }),
  ];
}

export function CardActions(props: {
  readonly card: Pick<WatchCard, "runId" | "endedAt" | "paused">;
  readonly steering: SteerControls | undefined;
  readonly controlling: RunCommandControls | undefined;
}): Shown {
  const { card } = props;
  if (card.endedAt !== null) return null;
  return [
    component(SteerAction, { runId: card.runId, steering: props.steering }),
    component(RunCommandMenu, {
      runId: card.runId,
      paused: card.paused === true,
      controlling: props.controlling,
    }),
  ];
}

export const runCommandFunctions = [
  RunCommandButtons,
  DropQuestion,
  RunCommandAction,
  RunCommandMenu,
  RunActions,
  CardActions,
];
