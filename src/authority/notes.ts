export const noteLimit = 4000;

const noteIdentity = /^note-[0-9a-f]{32}$/;

export function noteText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const length = Array.from(text).length;
  return length >= 1 && length <= noteLimit ? text : undefined;
}

export function isNoteText(value: unknown): value is string {
  return noteText(value) === value;
}

export function isNoteId(value: unknown): value is string {
  return typeof value === "string" && noteIdentity.test(value);
}
