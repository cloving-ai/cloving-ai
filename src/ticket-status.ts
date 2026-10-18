export type TicketStatus =
  | { readonly kind: "complete" }
  | { readonly kind: "partial"; readonly remaining: readonly string[] };

function parsedStatus(summary: string): TicketStatus | undefined {
  const lines = summary.trimEnd().split(/\r?\n/);
  if (lines.filter((line) => /^Ticket status:/i.test(line)).length !== 1)
    return undefined;
  const status = lines.pop();
  if (status === "Ticket status: complete") return { kind: "complete" };
  if (status !== "Ticket status: partial") return undefined;
  const heading = lines.lastIndexOf("Remaining:");
  if (heading === -1) return undefined;
  const items = lines.slice(heading + 1);
  if (items.length === 0 || items.some((line) => !/^- \S.*$/.test(line)))
    return undefined;
  return { kind: "partial", remaining: items.map((line) => line.slice(2)) };
}

function preservedStatus(value: unknown): TicketStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const kind: unknown = Reflect.get(value, "kind");
  if (kind === "complete") return { kind };
  const remaining: unknown = Reflect.get(value, "remaining");
  if (
    kind !== "partial" ||
    !Array.isArray(remaining) ||
    remaining.length === 0 ||
    remaining.some(
      (item: unknown) =>
        typeof item !== "string" || item.trim() === "" || /[\r\n]/.test(item),
    )
  )
    return undefined;
  return { kind, remaining: remaining.map(String) };
}

export function ticketStatus(
  summary: string,
  preserved?: unknown,
): TicketStatus {
  const parsed =
    preserved === undefined
      ? parsedStatus(summary)
      : preservedStatus(preserved);
  if (parsed !== undefined) return parsed;
  return {
    kind: "partial",
    remaining: ["The worker report has no ticket status line."],
  };
}

export function isTicketStatus(
  value: unknown,
): value is "complete" | "partial" {
  return value === "complete" || value === "partial";
}
