import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ticketOutput } from "./ticket-queue.mts";

const skipped = new Set(process.env["CLOVING_SKIP_TICKETS"]?.split(/\s+/));

const executed = promisify(execFile);
const output = await ticketOutput({
  gh: async (args) =>
    (
      await executed("gh", args, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
    ).stdout,
  format: (tickets) => {
    const next = tickets.find((ticket) => !skipped.has(ticket.id));
    return next === undefined ? "" : `${next.id}\n`;
  },
});
process.stdout.write(output.stdout);
process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
