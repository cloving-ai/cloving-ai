import type { TranscriptEntry } from "../turn-transcript.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { watchHash } from "./watch-navigation.ts";
import { counted, type WatchRun, type WatchTurn } from "./watch-render.ts";

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

export interface TranscriptControls {
  readonly view: (target: TranscriptTarget) => TranscriptView;
  readonly onToggle: (target: TranscriptTarget) => void;
  readonly onLink: (target: TranscriptTarget) => void;
  readonly onScroll: (operationId: string, box: TranscriptBox) => void;
  readonly onJump: (target: TranscriptTarget) => void;
  readonly onEarlier: (target: TranscriptTarget) => void;
  readonly onRetry: (target: TranscriptTarget) => void;
}

export function CutNote(props: { readonly entry: TranscriptEntry }): Shown {
  const { omittedBytes } = props.entry;
  if (omittedBytes === 0) return null;
  return element("p", {
    class: "entry-cut",
    children: `The output is cut: ${String(omittedBytes)} bytes are left out.`,
  });
}

export function ToolOutput(props: { readonly entry: TranscriptEntry }): Shown {
  const { entry } = props;
  const lines = entry.text.split("\n");
  const rest = lines.slice(20);
  const more =
    rest.length === 0
      ? null
      : element("details", {
          children: [
            element("summary", { children: counted(rest.length, "more line") }),
            element("pre", { children: rest.join("\n") }),
          ],
        });
  return element("div", {
    class: entry.error ? "entry tool-result error" : "entry tool-result",
    children: [
      entry.error
        ? element("span", { class: "entry-mark", children: "Error" })
        : null,
      element("pre", { children: lines.slice(0, 20).join("\n") }),
      more,
      component(CutNote, { entry }),
    ],
  });
}

export function TranscriptLine(props: {
  readonly entry: TranscriptEntry;
}): Shown {
  const { entry } = props;
  if (entry.kind === "tool-result") return component(ToolOutput, { entry });
  const body = [
    element("pre", { children: entry.text }),
    component(CutNote, { entry }),
  ];
  if (entry.kind === "thinking" || entry.kind === "tool-call")
    return element("details", {
      class: `entry ${entry.kind}`,
      children: [
        element("summary", {
          children: entry.kind === "thinking" ? "Thinking" : entry.summary,
        }),
        body,
      ],
    });
  const tone = entry.error ? " error" : "";
  return element("div", {
    class: `entry ${entry.kind}${tone}`,
    children: body,
  });
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

export function TranscriptBody(props: {
  readonly target: TranscriptTarget;
  readonly view: TranscriptView;
  readonly controls: TranscriptControls;
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
  const lines = element("div", {
    class: "transcript-lines",
    "data-transcript": target.operationId,
    onScroll: (event: { readonly currentTarget: TranscriptBox }) => {
      controls.onScroll(target.operationId, event.currentTarget);
    },
    children:
      view.entries.length === 0
        ? element("p", { class: "meta", children: waitingText(view.state) })
        : view.entries.map((entry) =>
            component(TranscriptLine, { key: String(entry.position), entry }),
          ),
  });
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
    lines,
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

export function Transcript(props: {
  readonly run: Pick<WatchRun, "runId" | "turns">;
  readonly turn: WatchTurn;
  readonly turnId: string | null;
  readonly controls: TranscriptControls | undefined;
}): Shown {
  const { run, turn, turnId, controls } = props;
  const { runId } = run;
  const { operationId } = turn;
  const target = {
    runId,
    operationId,
    wanted: transcriptWanted({ turns: run.turns, turn, turnId }),
  };
  const view = controls?.view(target);
  const link = element("a", {
    class: "transcript-link",
    href: watchHash({ workflowId: null, runId, turnId: operationId }),
    onClick: () => {
      controls?.onLink(target);
    },
    children: "Link",
  });
  const toggle = element("button", {
    type: "button",
    class: "transcript-toggle",
    onClick: () => {
      controls?.onToggle(target);
    },
    children: view?.shown === true ? "Hide" : "Show",
  });
  return element("section", {
    class: "transcript code-window",
    "data-turn": operationId,
    children: [
      element("div", {
        class: "code-head",
        children: ["Transcript ", toggle, " ", link],
      }),
      controls === undefined || view?.shown !== true
        ? null
        : component(TranscriptBody, { target, view, controls }),
    ],
  });
}
