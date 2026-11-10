import { component, element, type Shown } from "./watch-element.ts";
import type { WatchCard, WatchRun } from "./watch-render.ts";
import type { RunCommand } from "./runtime-invocation.ts";
import {
  SteerAction,
  steerable,
  type SteerControls,
} from "./watch-steer-view.ts";

export type RunCommandPlace = "detail" | "card" | "token" | "need";

export interface RunCommandReply {
  readonly command: RunCommand;
  readonly text: string;
}

export interface RunCommandControls {
  readonly busy: readonly string[];
  readonly messages: Readonly<Record<string, RunCommandReply>>;
  readonly asking: {
    readonly runId: string;
    readonly place: RunCommandPlace;
  } | null;
  readonly onCommand: (runId: string, command: RunCommand) => void;
  readonly onAsk: (runId: string, place: RunCommandPlace) => void;
  readonly onKeep: () => void;
}

interface RunCommandProps {
  readonly runId: string;
  readonly place: RunCommandPlace;
  readonly paused: boolean;
  readonly controlling: RunCommandControls | undefined;
}

export function RunCommandButtons(
  props: RunCommandProps & { readonly controlling: RunCommandControls },
): Shown {
  const { runId, place, paused, controlling } = props;
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
        controlling.onAsk(runId, place);
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

export function RunCommandMessage(props: {
  readonly text: string | undefined;
}): Shown {
  if (props.text === undefined) return null;
  return element("p", {
    class: "run-command-message",
    role: "status",
    children: props.text,
  });
}

export function dropReply(
  controlling: RunCommandControls | undefined,
  runId: string,
): string | undefined {
  const reply = controlling?.messages[runId];
  return reply?.command === "drop" ? reply.text : undefined;
}

export function RunCommandAction(props: RunCommandProps): Shown {
  const { runId, place, controlling } = props;
  if (controlling === undefined) return null;
  const asking = controlling.asking;
  return element("div", {
    class: "run-command",
    "data-run": runId,
    "data-place": place,
    children: [
      asking?.runId === runId && asking.place === place
        ? component(DropQuestion, { runId, controlling })
        : component(RunCommandButtons, { ...props, controlling }),
      component(RunCommandMessage, { text: controlling.messages[runId]?.text }),
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
  const { run, controlling } = props;
  if (!steerable(run.state))
    return component(RunCommandMessage, {
      text: dropReply(controlling, run.runId),
    });
  return [
    component(SteerAction, { runId: run.runId, steering: props.steering }),
    component(RunCommandAction, {
      runId: run.runId,
      place: "detail",
      paused: run.state === "paused",
      controlling,
    }),
  ];
}

export function CardActions(props: {
  readonly card: Pick<WatchCard, "runId" | "endedAt" | "paused">;
  readonly steering: SteerControls | undefined;
  readonly controlling: RunCommandControls | undefined;
}): Shown {
  const { card, controlling } = props;
  if (card.endedAt !== null) return null;
  return [
    component(SteerAction, { runId: card.runId, steering: props.steering }),
    component(RunCommandMenu, {
      runId: card.runId,
      place: "card",
      paused: card.paused === true,
      controlling,
    }),
  ];
}

export function RunCommandReplies(props: {
  readonly runs: readonly Pick<WatchRun, "runId" | "title">[];
  readonly controlling: RunCommandControls | undefined;
}): Shown {
  return props.runs.map((run) => {
    const text = dropReply(props.controlling, run.runId);
    if (text === undefined) return null;
    return component(RunCommandMessage, {
      key: run.runId,
      text: `${run.title ?? run.runId}: ${text}`,
    });
  });
}

export const runCommandFunctions = [
  RunCommandButtons,
  DropQuestion,
  RunCommandMessage,
  dropReply,
  RunCommandAction,
  RunCommandMenu,
  RunActions,
  CardActions,
  RunCommandReplies,
];
