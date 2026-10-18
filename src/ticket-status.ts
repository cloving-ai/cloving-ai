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

export function ticketStatus(summary: string): TicketStatus {
  const parsed = parsedStatus(summary);
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
