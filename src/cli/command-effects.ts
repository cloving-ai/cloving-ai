import { record } from "../protocol.ts";
import type { CommandEffect } from "../command-settings.ts";
import { element, type Shown } from "./watch-element.ts";

export function shownCommands(value: unknown): readonly CommandEffect[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const fields = record(entry);
    if (
      typeof fields?.["operationId"] !== "string" ||
      typeof fields["name"] !== "string" ||
      typeof fields["state"] !== "string"
    )
      return [];
    return [
      {
        operationId: fields["operationId"],
        name: fields["name"],
        state: fields["state"],
        exitCode:
          typeof fields["exitCode"] === "number" ? fields["exitCode"] : null,
        durationMilliseconds:
          typeof fields["durationMilliseconds"] === "number"
            ? fields["durationMilliseconds"]
            : null,
      },
    ];
  });
}

export function commandText(effect: CommandEffect): string {
  const duration =
    effect.durationMilliseconds === null
      ? "duration unknown"
      : `${String(effect.durationMilliseconds)} ms`;
  return `Command ${effect.name} · ${effect.state} · exit ${effect.exitCode === null ? "unknown" : String(effect.exitCode)} · ${duration}`;
}

export function Commands(props: {
  readonly effects: readonly CommandEffect[];
}): Shown {
  return props.effects.map((effect) =>
    element("section", {
      class: "command-effect code-window",
      children: element("h3", {
        class: "code-head",
        children: commandText(effect),
      }),
    }),
  );
}
