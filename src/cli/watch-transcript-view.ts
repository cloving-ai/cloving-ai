import type { TranscriptEntry } from "../turn-transcript.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { watchHash, type WatchLocation } from "./watch-navigation.ts";
import type { WatchModel, WatchRun, WatchTurn } from "./watch-render.ts";
import {
  terminalFunctions,
  terminalGroups,
  TerminalGroupView,
} from "./watch-terminal-view.ts";
import { turnHeading } from "./watch-turn.ts";

export interface TranscriptView {
  readonly shown: boolean;
  readonly entries: readonly TranscriptEntry[];
  readonly state: "loading" | "open" | "ended" | "not-kept" | "failed";
  readonly message: string;
  readonly earlier: boolean;
  readonly unseen: number;
  readonly detached: boolean;
}

export interface TranscriptTarget {
  readonly runId: string;
  readonly operationId: string;
  readonly wanted: boolean;
}

export interface TranscriptBox {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

export type RunTab = "transcript" | "turn" | "pull" | "events" | "details";

export interface TranscriptControls {
  readonly tab: RunTab;
  readonly onTab: (tab: RunTab) => void;
  readonly view: (target: TranscriptTarget) => TranscriptView;
  readonly onToggle: (target: TranscriptTarget) => void;
  readonly onLink: (target: TranscriptTarget) => void;
  readonly onScroll: (operationId: string, box: TranscriptBox) => void;
  readonly onJump: (target: TranscriptTarget) => void;
  readonly onEarlier: (target: TranscriptTarget) => void;
  readonly onRetry: (target: TranscriptTarget) => void;
}

export function waitingText(state: TranscriptView["state"]): string {
  return state === "loading"
    ? "The transcript loads."
    : "The transcript has no entries.";
}

export function TranscriptButton(props: {
  readonly name: string;
  readonly label: string;
  readonly onClick: () => void;
}): Shown {
  return element("button", {
    type: "button",
    class: props.name,
    onClick: props.onClick,
    children: props.label,
  });
}

export function jumpLabel(unseen: number): string {
  if (unseen === 0) return "Jump to the end";
  return `Jump to the end · ${String(unseen)} new ${unseen === 1 ? "entry" : "entries"}`;
}

export function TranscriptLines(props: {
  readonly target: TranscriptTarget;
  readonly view: TranscriptView;
  readonly controls: TranscriptControls;
  readonly worktree: string;
}): Shown {
  const { target, view, controls, worktree } = props;
  return element("div", {
    class: "transcript-lines",
    "data-transcript": target.operationId,
    onScroll: (event: { readonly currentTarget: TranscriptBox }) => {
      controls.onScroll(target.operationId, event.currentTarget);
    },
    children:
      view.entries.length === 0
        ? element("p", { class: "meta", children: waitingText(view.state) })
        : terminalGroups(view.entries).map((group) =>
            component(TerminalGroupView, {
              key: String(group.entry.position),
              group,
              worktree,
            }),
          ),
  });
}

export function TranscriptBody(props: {
  readonly target: TranscriptTarget;
  readonly view: TranscriptView;
  readonly controls: TranscriptControls;
  readonly worktree: string;
}): Shown {
  const { target, view, controls } = props;
  if (view.state === "not-kept")
    return element("p", {
      class: "meta",
      children: "The transcript of this turn is not kept.",
    });
  if (view.state === "failed")
    return [
      element("p", { class: "bad", children: view.message }),
      component(TranscriptButton, {
        name: "transcript-retry",
        label: "Retry",
        onClick: () => {
          controls.onRetry(target);
        },
      }),
    ];
  return [
    view.earlier
      ? component(TranscriptButton, {
          name: "transcript-earlier",
          label: "Load earlier entries",
          onClick: () => {
            controls.onEarlier(target);
          },
        })
      : null,
    component(TranscriptLines, props),
    view.unseen === 0 && !view.detached
      ? null
      : component(TranscriptButton, {
          name: "transcript-jump",
          label: jumpLabel(view.unseen),
          onClick: () => {
            controls.onJump(target);
          },
        }),
  ];
}

export function transcriptWanted(props: {
  readonly turns: readonly WatchTurn[];
  readonly turn: WatchTurn;
  readonly turnId: string | null;
}): boolean {
  const { turns, turn, turnId } = props;
  if (turn.outcome === "in work" || turn.operationId === turnId) return true;
  const chosen = turns.some(
    (item) => item.outcome === "in work" || item.operationId === turnId,
  );
  if (chosen) return false;
  const last = turns.reduce(
    (latest, item) => (item.startedAt >= latest.startedAt ? item : latest),
    turn,
  );
  return last.operationId === turn.operationId;
}

export function TranscriptHead(props: {
  readonly target: TranscriptTarget;
  readonly heading: string;
  readonly view: TranscriptView | undefined;
  readonly controls: TranscriptControls | undefined;
  readonly layout: "detail" | "terminal";
}): Shown {
  const { target, view, controls, layout } = props;
  const place = {
    workflowId: null,
    runId: target.runId,
    turnId: target.operationId,
  };
  const link = element("a", {
    class: "transcript-link",
    href: watchHash(place),
    onClick: () => {
      controls?.onLink(target);
    },
    children: layout === "terminal" ? "Run detail" : "Link",
  });
  const full = element("a", {
    class: "transcript-full",
    href: watchHash({ ...place, view: "terminal" }),
    children: "Full screen",
  });
  const toggle = element("button", {
    type: "button",
    class: "transcript-toggle",
    onClick: () => {
      controls?.onToggle(target);
    },
    children: view?.shown === true ? "Hide" : "Show",
  });
  return element("div", {
    class: "code-head",
    children: [
      `${props.heading} `,
      toggle,
      " ",
      link,
      layout === "terminal" ? null : [" ", full],
    ],
  });
}

export function Transcript(props: {
  readonly run: Pick<WatchRun, "runId" | "turns">;
  readonly turn: WatchTurn;
  readonly turnId: string | null;
  readonly controls: TranscriptControls | undefined;
  readonly now: string;
  readonly layout?: "terminal";
}): Shown {
  const { run, turn, turnId, controls } = props;
  const position =
    run.turns.findIndex((item) => item.operationId === turn.operationId) + 1;
  const target = {
    runId: run.runId,
    operationId: turn.operationId,
    wanted: transcriptWanted({ turns: run.turns, turn, turnId }),
  };
  const view = controls?.view(target);
  return element("section", {
    class: "transcript code-window",
    "data-turn": turn.operationId,
    children: [
      component(TranscriptHead, {
        target,
        heading: turnHeading(turn, {
          label: `Turn ${String(position)}`,
          now: props.now,
        }),
        view,
        controls,
        layout: props.layout ?? "detail",
      }),
      controls === undefined || view?.shown !== true
        ? null
        : component(TranscriptBody, {
            target,
            view,
            controls,
            worktree: turn.worktree,
          }),
    ],
  });
}

export function TerminalPage(props: {
  readonly model: WatchModel;
  readonly location: WatchLocation;
  readonly now: string;
  readonly transcripts?: TranscriptControls | undefined;
}): Shown {
  const { model, location } = props;
  const run = model.runs.find((item) => item.runId === location.runId);
  const turn = run?.turns.find((item) => item.operationId === location.turnId);
  return element("div", {
    class: "terminal-page",
    children:
      run === undefined || turn === undefined
        ? element("p", {
            class: "meta",
            children: "This turn is not available.",
          })
        : component(Transcript, {
            run,
            turn,
            turnId: turn.operationId,
            controls: props.transcripts,
            now: props.now,
            layout: "terminal",
          }),
  });
}

export const transcriptFunctions = [
  ...terminalFunctions,
  waitingText,
  TranscriptButton,
  jumpLabel,
  TranscriptLines,
  TranscriptBody,
  transcriptWanted,
  TranscriptHead,
  Transcript,
  TerminalPage,
];
