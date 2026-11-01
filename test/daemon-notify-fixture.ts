import { queuePrelude } from "./daemon-queue-fixture.ts";

export const notifyWorkflow = `
import { readFileSync, existsSync } from "node:fs";
import { decisionGate } from "cloving/workflows/steps/decision-gate";
export async function scenario(ticketId) {
  "use step";
  return existsSync("scenario-" + ticketId)
    ? JSON.parse(readFileSync("scenario-" + ticketId, "utf8"))
    : { kind: "approval", prompt: "Approve this change?" };
}
export async function develop(input) {
  "use workflow";
  const choice = await scenario(input.input.ticket.id);
  if (choice.kind === "failed") throw new Error("fixture failure");
  if (choice.kind === "blocked" || choice.kind === "handoff_requested")
    return { kind: choice.kind, reason: "fixture outcome reason" };
  const gate = await decisionGate({ gateId: "review-1", kind: choice.kind, prompt: choice.prompt });
  return { kind: "waiting_for_decision", decisionId: gate.decisionId };
}
`;

export const notifyPrelude = `${queuePrelude}
settings.queueMilliseconds = undefined;
settings.notifyMilliseconds = 30;
settings.notifyCommand = [process.execPath, directory + "/notify.mjs"];
writeFileSync("notify.mjs", \`import { appendFileSync } from "node:fs";
let text = "";
for await (const chunk of process.stdin) text += chunk;
appendFileSync("notifications", text);
\`);
const notices = () => existsSync("notifications")
  ? readFileSync("notifications", "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
const submitNotice = async (ticket, choice) => {
  if (choice) writeFileSync("scenario-" + ticket, JSON.stringify(choice));
  return (await submitted(ticket, { submission: { ticket } })).runId;
};
`;
