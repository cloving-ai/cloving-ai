import {
  continuedCostText,
  priceText,
  spendLimitText,
  usageText,
  totalsSuffix,
} from "./usage-render.ts";
import { element, type Shown } from "./watch-element.ts";
import { phaseTime, type WatchPhase, type WatchRun } from "./watch-render.ts";

export function Phases(props: {
  readonly phases: readonly WatchPhase[];
  readonly now: string;
}): Shown {
  const marks: Readonly<Record<string, string>> = {
    done: "✓",
    active: "●",
    failed: "✕",
  };
  const steps = props.phases.map((phase) =>
    element("li", {
      class: `phase ${phase.state}`,
      children: [
        element("span", { class: "mark", children: marks[phase.state] ?? "○" }),
        element("span", { class: "name", children: phase.name }),
        element("span", {
          class: "time",
          children: phaseTime(phase, props.now),
        }),
      ],
    }),
  );
  return element("ol", { class: "phases", children: steps });
}

export function RunTotals(props: { readonly run: WatchRun }): Shown {
  const { run } = props;
  return element("section", {
    class: "run-usage",
    children: [
      element("h3", { children: `Run totals${totalsSuffix(run.state)}` }),
      element("p", { children: usageText(run.usage) }),
      element("p", {
        children: `${priceText(run.claudeCostUsd, run.estimatedCostUsd)}${spendLimitText(run.spendLimitUsd)}`,
      }),
      run.continuedCostUsd === undefined
        ? null
        : element("p", {
            children: continuedCostText(run.continuedCostUsd),
          }),
    ],
  });
}
