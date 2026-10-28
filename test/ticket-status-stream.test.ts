import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketStatus } from "../src/ticket-status.ts";
import { ticketStatusStream } from "../src/ticket-status-stream.ts";

await test("CLV-215 streamed status matches full reports across every chunk boundary", () => {
  const reports = [
    "Changed.\nTicket status: complete",
    "Remaining:\r\n \t\r\n- First.\r\n\t\r\n- Second.\r\nTicket status: partial\r\n \t\r\n",
    "Remaining:\n- Old.\nRemaining:\n- New.\nTicket status: partial",
    "Remaining:\n- Valid.\nMissing bullet\nTicket status: partial",
    "No remaining heading.\nTicket status: partial",
    "Remaining:\n- \nTicket status: partial",
    "Ticket status: complete\nMore work.",
    "Ticket status: complete\nTicket status: complete",
    "TICKET STATUS: complete\nTicket status: complete",
    "Ticket status: complete \t\r\n \t\n",
    "Remaining: \n- Work.\nTicket status: partial",
    "No status.",
    "",
  ];
  for (const report of reports) {
    for (let boundary = 0; boundary <= report.length; boundary++) {
      const stream = ticketStatusStream(128);
      stream.write(report.slice(0, boundary));
      stream.write(report.slice(boundary));
      assert.deepEqual(stream.result(), { ticketStatus: ticketStatus(report) });
    }
  }
});

await test("CLV-215 streamed status sees duplicates outside the output tail and long lines", () => {
  const reports = [
    "Ticket status: complete\n" +
      "x".repeat(10000) +
      "\nTicket status: complete",
    "Ticket status:" + "x".repeat(10000) + "\nTicket status: complete",
    "x".repeat(10000) + "\nTicket status: complete",
    "x".repeat(10000) + "Ticket status: complete",
    "Ticket status: complete" + " ".repeat(10000),
    "Remaining:\n- Work.\n" + " \t\n".repeat(1000) + "Ticket status: partial",
  ];
  for (const report of reports) {
    const stream = ticketStatusStream(128);
    for (let offset = 0; offset < report.length; offset += 7)
      stream.write(report.slice(offset, offset + 7));
    assert.deepEqual(stream.result(), { ticketStatus: ticketStatus(report) });
  }
});

await test("CLV-215 streamed status bounds oversized remaining lists and resets at a later heading", () => {
  const list = "Remaining:\n- " + "r".repeat(10000);
  const stream = ticketStatusStream(128);
  stream.write(list + "\nTicket status: partial");
  assert.equal(stream.result().ticketStatusTooLarge, true);
  for (const ending of [
    "\nTicket status: complete",
    "\nInvalid item\nTicket status: partial",
    "\nRemaining:\n- New.\nTicket status: partial",
  ]) {
    const reset = ticketStatusStream(128);
    reset.write(list);
    reset.write(ending);
    assert.deepEqual(reset.result(), {
      ticketStatus: ticketStatus(list + ending),
    });
  }
});

await test("CLV-215 streamed status validates remaining items beyond the retained line prefix", () => {
  for (const separator of ["\r", "\u2028", "\u2029"]) {
    const report =
      "Remaining:\n- " +
      "r".repeat(10000) +
      separator +
      "continued\nTicket status: partial";
    const stream = ticketStatusStream(128);
    for (let offset = 0; offset < report.length; offset += 7)
      stream.write(report.slice(offset, offset + 7));
    assert.deepEqual(stream.result(), { ticketStatus: ticketStatus(report) });
  }
});
