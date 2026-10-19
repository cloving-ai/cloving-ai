import { component, element, type Shown } from "./watch-element.ts";
import type { CardField, CardForm } from "./watch-run-input.ts";

export interface CardDraft {
  readonly commandId: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly pending: boolean;
  readonly admitted: boolean;
  readonly message: string;
}

export interface CardControls {
  readonly draft: CardDraft | null;
  readonly onOpen: () => void;
  readonly onCancel: () => void;
  readonly onChange: (name: string, value: string) => void;
  readonly onSubmit: () => void;
}

export interface CardKeyEvent {
  readonly key: string;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  readonly repeat?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly target?: { readonly localName?: string };
  readonly preventDefault: () => void;
}

export function cardSubmitKey(event: CardKeyEvent): boolean {
  const name = event.target?.localName;
  return (
    name === "input" ||
    (name === "textarea" && Boolean(event.ctrlKey || event.metaKey))
  );
}

export function cardKey(event: CardKeyEvent, controls: CardControls): void {
  if (event.defaultPrevented || event.isComposing || event.repeat) return;
  if (event.key === "Escape") {
    event.preventDefault();
    controls.onCancel();
    return;
  }
  if (event.key !== "Enter") return;
  if (!cardSubmitKey(event)) return;
  event.preventDefault();
  controls.onSubmit();
}

export function CardInput(props: {
  readonly field: CardField;
  readonly controls: CardControls;
  readonly draft: CardDraft;
}): Shown {
  const { field, controls, draft } = props;
  return element("label", {
    children: [
      field.label,
      element(field.multiline ? "textarea" : "input", {
        name: field.name,
        type: field.multiline ? undefined : "text",
        rows: field.multiline ? 5 : undefined,
        value: draft.fields[field.name] ?? "",
        required: !field.optional,
        disabled: draft.pending || draft.admitted,
        onInput: (event: { currentTarget: { value: string } }) => {
          controls.onChange(field.name, event.currentTarget.value);
        },
      }),
    ],
  });
}

export function AddCard(props: {
  readonly form: CardForm | undefined;
  readonly controls: CardControls | undefined;
}): Shown {
  const { form, controls } = props;
  if (form === undefined || controls === undefined) return null;
  const { draft } = controls;
  if (draft === null)
    return element("button", {
      class: "add-card",
      type: "button",
      onClick: controls.onOpen,
      children: "+ Add a card",
    });
  return element("form", {
    class: "add-card-form",
    onKeyDown: (event: CardKeyEvent) => {
      cardKey(event, controls);
    },
    onSubmit: (event: Event) => {
      event.preventDefault();
      controls.onSubmit();
    },
    children: [
      form.fields.map((field) =>
        component(CardInput, { key: field.name, field, controls, draft }),
      ),
      element("button", {
        type: "submit",
        disabled: draft.pending || draft.admitted,
        children: draft.pending ? "Adding…" : "Add card",
      }),
      element("button", {
        type: "button",
        onClick: controls.onCancel,
        children: "Cancel",
      }),
      element("p", {
        role: "status",
        "aria-live": "polite",
        children: draft.message,
      }),
    ],
  });
}
