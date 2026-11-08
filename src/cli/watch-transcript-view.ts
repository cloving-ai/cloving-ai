import type { TranscriptEntry } from "../turn-transcript.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { watchHash } from "./watch-navigation.ts";
import { counted, type WatchTurn } from "./watch-render.ts";

export interface TranscriptView {
  readonly shown: boolean;
  readonly entries: readonly TranscriptEntry[];
  readonly state: "loading" | "open" | "ended" | "not-kept" | "failed";
  readonly message: string;
  readonly earlier: boolean;
  readonly unseen: number;
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
  readonly onScroll: (operationId: string, box: TranscriptBox) => void;
  readonly onJump: (target: TranscriptTarget) => void;
  readonly onEarlier: (target: TranscriptTarget) => void;
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

function waitingText(state: TranscriptView["state"]): string {
  return state === "loading"
    ? "The transcript loads."
    : "The transcript has no entries.";
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
    return element("p", { class: "bad", children: view.message });
  const button = (shown: {
    readonly name: string;
    readonly label: string;
    readonly onClick: () => void;
  }): Shown =>
    element("button", {
      type: "button",
      class: shown.name,
      onClick: shown.onClick,
      children: shown.label,
    });
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
      ? button({
          name: "transcript-earlier",
          label: "Load earlier entries",
          onClick: () => {
            controls.onEarlier(target);
          },
        })
      : null,
    lines,
    view.unseen === 0
      ? null
      : button({
          name: "transcript-jump",
          label: `Jump to the end · ${String(view.unseen)} new ${view.unseen === 1 ? "entry" : "entries"}`,
          onClick: () => {
            controls.onJump(target);
          },
        }),
  ];
}

export function Transcript(props: {
  readonly runId: string;
  readonly turn: WatchTurn;
  readonly turnId: string | null;
  readonly controls: TranscriptControls | undefined;
}): Shown {
  const { runId, turn, controls } = props;
  const { operationId } = turn;
  const target = {
    runId,
    operationId,
    wanted: turn.outcome === "in work" || operationId === props.turnId,
  };
  const view = controls?.view(target);
  const link = element("a", {
    class: "transcript-link",
    href: watchHash({ workflowId: null, runId, turnId: operationId }),
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
