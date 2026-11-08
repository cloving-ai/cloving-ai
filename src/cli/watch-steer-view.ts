import { cardKey, type CardKeyEvent } from "./watch-card-view.ts";
import { component, element, type Shown } from "./watch-element.ts";

export interface SteerControls {
  readonly open: string | null;
  readonly note: string;
  readonly now: boolean;
  readonly busy: readonly string[];
  readonly messages: Readonly<Record<string, string>>;
  readonly onOpen: (runId: string) => void;
  readonly onClose: () => void;
  readonly onNote: (text: string) => void;
  readonly onNow: (now: boolean) => void;
  readonly onSend: (runId: string) => void;
}

export function steerable(state: string): boolean {
  return !["completed", "failed", "cancelled"].includes(state);
}

export function NoteMark(props: { readonly waiting: number }): Shown {
  const { waiting } = props;
  if (waiting === 0) return null;
  return element("span", {
    class: "note-mark",
    children: `${String(waiting)} ${waiting === 1 ? "note" : "notes"} waiting`,
  });
}

export function SteerForm(props: {
  readonly runId: string;
  readonly steering: SteerControls;
}): Shown {
  const { runId, steering } = props;
  return element("form", {
    class: "steer-form",
    onKeyDown: (event: CardKeyEvent) => {
      cardKey(event, { onCancel: steering.onClose });
    },
    onSubmit: (event: Event) => {
      event.preventDefault();
      steering.onSend(runId);
    },
    children: [
      element("label", {
        children: [
          "Note for the run",
          element("textarea", {
            name: "note",
            rows: 3,
            value: steering.note,
            required: true,
            onInput: (event: { currentTarget: { value: string } }) => {
              steering.onNote(event.currentTarget.value);
            },
          }),
        ],
      }),
      element("label", {
        children: [
          element("input", {
            type: "checkbox",
            name: "now",
            checked: steering.now,
            onChange: (event: { currentTarget: { checked: boolean } }) => {
              steering.onNow(event.currentTarget.checked);
            },
          }),
          " Send to the turn in work now",
        ],
      }),
      element("button", {
        type: "submit",
        ...(steering.busy.includes(runId) ? { disabled: true } : {}),
        children: "Send",
      }),
      element("button", {
        type: "button",
        onClick: steering.onClose,
        children: "Cancel",
      }),
    ],
  });
}

export function SteerAction(props: {
  readonly runId: string;
  readonly steering: SteerControls | undefined;
}): Shown {
  const { runId, steering } = props;
  if (steering === undefined) return null;
  const message = steering.messages[runId];
  return element("div", {
    class: "steer",
    children: [
      steering.open === runId
        ? component(SteerForm, { runId, steering })
        : element("button", {
            type: "button",
            class: "steer-open",
            onClick: () => {
              steering.onOpen(runId);
            },
            children: "Steer",
          }),
      message === undefined
        ? null
        : element("p", {
            class: "steer-message",
            role: "status",
            children: message,
          }),
    ],
  });
}
