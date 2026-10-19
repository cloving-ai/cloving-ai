import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketStatus } from "../src/ticket-status.ts";

await test("CLV-146 reads the remaining items from the reported Markdown", () => {
  const report = `Remaining:

- Durable question gates, deadline forwarding, and expiry.
- Exact-choice answer continuation and the restricted second turn.
- Five-unit path and answer-restart acceptance coverage.

Ticket status: partial`;
  assert.deepEqual(ticketStatus(report), {
    kind: "partial",
    remaining: [
      "Durable question gates, deadline forwarding, and expiry.",
      "Exact-choice answer continuation and the restricted second turn.",
      "Five-unit path and answer-restart acceptance coverage.",
    ],
  });
});

await test("CLV-146 ignores whitespace-only lines around and between remaining items", () => {
  assert.deepEqual(
    ticketStatus(
      "Remaining:\r\n \t\r\n- First item.\r\n\t\r\n- Second item.\r\n  \r\nTicket status: partial\r\n \t\r\n",
    ),
    { kind: "partial", remaining: ["First item.", "Second item."] },
  );
});

await test("CLV-123 preserved report fields survive summary shortening and reject malformed data", () => {
  const complete = { kind: "complete" };
  const partial = { kind: "partial", remaining: ["Exact first.", "Second."] };
  assert.deepEqual(ticketStatus("Shortened.", complete), complete);
  assert.deepEqual(ticketStatus("Shortened.", partial), partial);
  for (const value of [
    null,
    {},
    { kind: "unknown" },
    { kind: "partial" },
    { kind: "partial", remaining: [] },
    { kind: "partial", remaining: [1] },
    { kind: "partial", remaining: [" "] },
    { kind: "partial", remaining: ["Two\nlines"] },
  ])
    assert.deepEqual(ticketStatus("Ticket status: complete", value), {
      kind: "partial",
      remaining: ["The worker report has no ticket status line."],
    });
});

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

await test("CLV-146 identifies unreadable remaining lists instead of missing status lines", () => {
  for (const list of [
    "",
    "Remaining:\n\n- Valid item.\nMissing bullet\n",
    "No remaining heading.",
    "Remaining:\n \t\n",
    "Remaining:\n- \n",
  ])
    assert.deepEqual(ticketStatus(`${list}\nTicket status: partial`), {
      kind: "partial",
      remaining: ["The worker report has an unreadable Remaining: list."],
    });
});

await test("CLV-123 unknown and repeated status lines fail closed as partial", () => {
  for (const report of [
    "No status.",
    "Ticket status: unknown",
    "Ticket status: complete\nTicket status: complete",
    "Ticket status: partial\nTicket status: complete",
    "Ticket status: complete\nMore work.",
    "Remaining:\n- Work.\nTicket status: partial\nMore work.",
    "Ticket status: complete\nRemaining:\n- Work.\nTicket status: partial",
    "Remaining:\n- Work.\nTicket status: partial\nTicket status: partial",
  ])
    assert.deepEqual(ticketStatus(report), {
      kind: "partial",
      remaining: ["The worker report has no ticket status line."],
    });
});

await test("CLV-146 a remaining list without a status line reports the missing line", () => {
  assert.deepEqual(ticketStatus("Remaining:\n\n- Add recovery.\n\n"), {
    kind: "partial",
    remaining: ["The worker report has no ticket status line."],
  });
});
