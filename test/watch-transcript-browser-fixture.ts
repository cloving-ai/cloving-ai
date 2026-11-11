export const said = (words: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: words }] },
  });
export const called = (command: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name: "Bash", input: { command } }],
    },
  });
export const output = (text: string): string =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: text }] },
  });
export const paired = (index: number): string =>
  [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: `call-${String(index)}`,
            name: "Bash",
            input: { command: `echo ${String(index)}` },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: `call-${String(index)}`,
            content: "one\ntwo\nthree",
          },
        ],
      },
    }),
  ].join("\n");
export const compactLines = `(async () => {
  const all = () => [...document.querySelectorAll(".transcript-lines .entry.tool-call")];
  for (let attempt = 0; attempt < 500 && (all().length < 40 || !document.querySelector(".transcript-lines .markdown strong")); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const box = document.querySelector(".transcript-lines");
  const rows = all().map((call) => {
    const line = call.querySelector(".tool-line > summary").getBoundingClientRect();
    const fold = call.querySelector(".tool-result > summary").getBoundingClientRect();
    return { height: call.getBoundingClientRect().height, same: Math.abs(line.top - fold.top) < 2 && fold.left > line.right - 1 };
  });
  return {
    calls: rows.length,
    tallest: Math.max(...rows.map((row) => row.height)),
    sameRow: rows.every((row) => row.same),
    box: box.clientHeight,
    scroll: box.scrollHeight,
    strong: document.querySelector(".transcript-lines .markdown strong")?.textContent ?? null,
  };
})()`;
export const panelBox = `(async () => {
  for (let attempt = 0; attempt < 500 && !document.querySelector(".transcript-lines .entry"); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const box = document.querySelector(".transcript").getBoundingClientRect();
  return {
    headers: document.querySelectorAll("header").length,
    sections: document.querySelectorAll("section").length,
    width: box.width,
    height: box.height,
    window: [innerWidth, innerHeight],
  };
})()`;

export const expandBox = (expanded: "true" | "false") => `(async () => {
  const button = () => document.querySelector(".transcript-expand");
  for (let attempt = 0; attempt < 500 && button()?.getAttribute("aria-expanded") !== "${expanded}"; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const box = document.querySelector(".transcript-lines");
  const area = box.getBoundingClientRect();
  const place = button().getBoundingClientRect();
  return {
    expanded: button().getAttribute("aria-expanded"),
    height: area.height,
    scroll: box.scrollHeight,
    top: area.top,
    right: place.right,
    bottom: place.bottom,
    edge: document.querySelector(".transcript").getBoundingClientRect().right,
  };
})()`;
