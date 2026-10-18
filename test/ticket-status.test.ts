import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketStatus } from "../src/ticket-status.ts";

await test("CLV-123 recognizes exactly one final complete or partial status", () => {
  assert.deepEqual(
    ticketStatus("Changed and checked.\nTicket status: complete"),
    {
      kind: "complete",
    },
  );
  assert.deepEqual(
    ticketStatus(
      "Changed.\nRemaining:\n- First item.\n- Second item.\nTicket status: partial\n",
    ),
    { kind: "partial", remaining: ["First item.", "Second item."] },
  );
});

await test("CLV-123 unknown, repeated and malformed reports fail closed as partial", () => {
  for (const report of [
    "No status.",
    "Ticket status: unknown",
    "Ticket status: complete\nTicket status: complete",
    "Ticket status: partial\nTicket status: complete",
    "Ticket status: complete\nMore work.",
    "Ticket status: partial",
    "Remaining:\n- \nTicket status: partial",
    "Remaining:\nMissing bullet\nTicket status: partial",
  ])
    assert.deepEqual(ticketStatus(report), {
      kind: "partial",
      remaining: ["The worker report has no ticket status line."],
    });
});
