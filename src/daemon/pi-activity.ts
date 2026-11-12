import { record, type Fields } from "../protocol.ts";

interface Display {
  message: number;
  active: boolean;
  readonly shown: Set<number>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function displayed(
  state: Display,
  block: {
    readonly index: number;
    readonly part: Fields;
    readonly partial?: true;
  },
): readonly string[] {
  const { index, part } = block;
  const type = part["type"];
  const value = type === "thinking" ? part["thinking"] : part["text"];
  const replaceId = `pi:message:${String(state.message)}:${String(index)}`;
  if (text(value).trim() === "") {
    if (!state.shown.delete(index)) return [];
    return [JSON.stringify({ type: "transcript_remove", replaceId })];
  }
  state.shown.add(index);
  return [
    JSON.stringify({
      type: "assistant",
      replaceId,
      ...(block.partial === true ? { partial: true } : {}),
      message: { content: [part] },
    }),
  ];
}

function begun(state: Display, message: Fields): readonly string[] {
  state.message += 1;
  state.active = true;
  state.shown.clear();
  const content: unknown = message["content"];
  if (!Array.isArray(content)) return [];
  return content.flatMap((value: unknown, index) => {
    const part = record(value);
    if (
      part === undefined ||
      !["text", "thinking"].includes(text(part["type"]))
    )
      return [];
    return displayed(state, { index, part, partial: true });
  });
}

function updated(state: Display, event: Fields): readonly string[] {
  const update = record(event["assistantMessageEvent"]) ?? {};
  const type = text(update["type"]);
  const index = update["contentIndex"];
  if (typeof index !== "number") return [];
  if (!state.active) begun(state, {});
  const kind = type.startsWith("thinking_") ? "thinking" : "text";
  if (![`${kind}_start`, `${kind}_delta`, `${kind}_end`].includes(type))
    return [];
  if (type.endsWith("_delta")) {
    state.shown.add(index);
    return [
      JSON.stringify({
        type: "transcript_delta",
        kind: kind === "text" ? "assistant" : "thinking",
        replaceId: `pi:message:${String(state.message)}:${String(index)}`,
        delta: text(update["delta"]),
      }),
    ];
  }
  const value = type.endsWith("_end") ? text(update["content"]) : "";
  const part = { type: kind, [kind]: value };
  return displayed(state, { index, part, partial: true });
}

function completed(state: Display, message: Fields): readonly string[] {
  if (!state.active) begun(state, {});
  const content = message["content"];
  if (!Array.isArray(content)) return [];
  const final = new Map<number, Fields>();
  content.forEach((value: unknown, index) => {
    const part = record(value);
    if (part !== undefined && ["text", "thinking"].includes(text(part["type"])))
      final.set(index, part);
  });
  const indices = new Set([...state.shown, ...final.keys()]);
  const lines = [...indices]
    .sort((first, second) => first - second)
    .flatMap((index) =>
      displayed(state, { index, part: final.get(index) ?? {} }),
    );
  state.active = false;
  return lines;
}

export function piActivity() {
  const state: Display = {
    message: 0,
    active: false,
    shown: new Set(),
  };
  return {
    start: (message: Fields) => begun(state, message),
    update: (event: Fields) => updated(state, event),
    completed: (message: Fields) => completed(state, message),
  };
}
