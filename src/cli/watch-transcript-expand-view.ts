import { element, type Shown } from "./watch-element.ts";

export function ExpandButton(props: {
  readonly expanded: boolean;
  readonly onExpand: () => void;
}): Shown {
  const label = props.expanded ? "Collapse transcript" : "Expand transcript";
  return element("button", {
    type: "button",
    class: "transcript-expand",
    title: label,
    "aria-label": label,
    "aria-expanded": props.expanded ? "true" : "false",
    onClick: props.onExpand,
    children: props.expanded ? "⤡" : "⤢",
  });
}

export const transcriptExpandFunctions = [ExpandButton];
