import { cardKey, type CardKeyEvent } from "./watch-card-view.ts";
import { component, element, type Shown } from "./watch-element.ts";
import { steerFunctions } from "./watch-steer-view.ts";

export interface RenameTarget {
  readonly runId: string;
  readonly title: string;
  readonly label: string;
}

export interface RenameControls {
  readonly open: string | null;
  readonly title: string;
  readonly label: string;
  readonly busy: readonly string[];
  readonly messages: Readonly<Record<string, string>>;
  readonly onOpen: (target: RenameTarget) => void;
  readonly onClose: () => void;
  readonly onTitle: (text: string) => void;
  readonly onLabel: (text: string) => void;
  readonly onSave: (runId: string) => void;
  readonly onClear: (runId: string) => void;
}

export interface NamedRun {
  readonly runId: string;
  readonly title: string | null;
  readonly label?: string | null | undefined;
  readonly manualName?: true | undefined;
}

interface TextEvent {
  readonly currentTarget: { readonly value: string };
}

export function pullMark(number: number | null): string | null {
  return number === null ? null : `PR #${String(number)}`;
}

export function NameMark(props: {
  readonly tone: string;
  readonly text: string | null | undefined;
}): Shown {
  const { tone, text } = props;
  if (text === null || text === undefined) return null;
  return element("span", { class: tone, children: text });
}

export function NameMarks(props: {
  readonly tone: string;
  readonly label: string | null | undefined;
  readonly pullRequestNumber: number | null;
}): Shown {
  const { tone, label, pullRequestNumber } = props;
  if ((label ?? null) === null && pullRequestNumber === null) return null;
  return element("span", {
    class: `${tone}-ids`,
    children: [
      component(NameMark, { tone: `${tone}-label`, text: label }),
      component(NameMark, {
        tone: `${tone}-pull`,
        text: pullMark(pullRequestNumber),
      }),
    ],
  });
}

export function RenameForm(props: {
  readonly runId: string;
  readonly renaming: RenameControls;
}): Shown {
  const { runId, renaming } = props;
  const field = (name: string, change: (text: string) => void) =>
    element("input", {
      name,
      value: name === "title" ? renaming.title : renaming.label,
      maxLength: name === "title" ? 200 : 32,
      ...(name === "title" ? { required: true } : {}),
      onInput: (event: TextEvent) => {
        change(event.currentTarget.value);
      },
    });
  return element("form", {
    class: "rename-form",
    onKeyDown: (event: CardKeyEvent) => {
      cardKey(event, { onCancel: renaming.onClose });
    },
    onSubmit: (event: Event) => {
      event.preventDefault();
      renaming.onSave(runId);
    },
    children: [
      element("label", {
        children: ["Title", field("title", renaming.onTitle)],
      }),
      element("label", {
        children: ["Label", field("label", renaming.onLabel)],
      }),
      element("button", {
        type: "submit",
        ...(renaming.busy.includes(runId) ? { disabled: true } : {}),
        children: "Save",
      }),
      element("button", {
        type: "button",
        onClick: renaming.onClose,
        children: "Cancel",
      }),
    ],
  });
}

export function RenameButtons(props: {
  readonly run: NamedRun;
  readonly renaming: RenameControls;
}): Shown {
  const { run, renaming } = props;
  const waiting = renaming.busy.includes(run.runId) ? { disabled: true } : {};
  return [
    element("button", {
      type: "button",
      class: "rename-open",
      ...waiting,
      onClick: () => {
        renaming.onOpen({
          runId: run.runId,
          title: run.title ?? "",
          label: run.label ?? "",
        });
      },
      children: "Rename",
    }),
    run.manualName === true
      ? element("button", {
          type: "button",
          class: "rename-clear",
          ...waiting,
          onClick: () => {
            renaming.onClear(run.runId);
          },
          children: "Use the automatic name",
        })
      : null,
  ];
}

export function RenameAction(props: {
  readonly run: NamedRun;
  readonly renaming?: RenameControls | undefined;
}): Shown {
  const { run, renaming } = props;
  if (renaming === undefined) return null;
  const message = renaming.messages[run.runId];
  return element("div", {
    class: "rename",
    children: [
      renaming.open === run.runId
        ? component(RenameForm, { runId: run.runId, renaming })
        : component(RenameButtons, { run, renaming }),
      message === undefined
        ? null
        : element("p", {
            class: "rename-message",
            role: "status",
            children: message,
          }),
    ],
  });
}

export function RunHeading(props: {
  readonly run: NamedRun & {
    readonly pullRequest: { readonly number: number } | null;
  };
  readonly renaming?: RenameControls | undefined;
}): Shown {
  const { run } = props;
  return [
    element("p", {
      class: "run-name",
      children: [
        component(NameMark, { tone: "name-label", text: run.label }),
        element("span", {
          class: "name-title",
          children: run.title ?? run.runId,
        }),
        component(NameMark, {
          tone: "name-pull",
          text: pullMark(run.pullRequest?.number ?? null),
        }),
      ],
    }),
    component(RenameAction, { run, renaming: props.renaming }),
  ];
}

export const runActionFunctions = [
  ...steerFunctions,
  pullMark,
  NameMark,
  NameMarks,
  RenameForm,
  RenameButtons,
  RenameAction,
  RunHeading,
];
