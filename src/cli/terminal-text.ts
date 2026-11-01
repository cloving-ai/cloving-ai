export function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function escaped(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

const hiddenRanges: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

function hidden(character: string): boolean {
  const code = character.charCodeAt(0);
  return hiddenRanges.some(([first, last]) => code >= first && code <= last);
}

export function oneLine(value: unknown): string {
  return Array.from(show(value), (character) =>
    hidden(character) ? escaped(character) : character,
  ).join("");
}

export function visible(value: unknown): string {
  return show(value)
    .split("\n")
    .map((line) =>
      Array.from(line, (character) =>
        hidden(character) ? escaped(character) : character,
      ).join(""),
    )
    .join("\n    ");
}
