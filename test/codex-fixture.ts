export const fakeCodex = `
import { writeFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
writeFileSync("codex-work.txt", prompt);
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "thread.started", thread_id: "thread-1" });
line({ type: "item.started", item: { type: "command_execution", command: "git status" } });
line({ type: "item.completed", item: { type: "command_execution", exit_code: 0 } });
line({ type: "item.completed", item: { type: "file_change", changes: [{ path: "codex-work.txt", kind: "add" }] } });
line({ type: "item.completed", item: { type: "agent_message", text: "Working." } });
line({ type: "item.completed", item: { type: "agent_message", text: "Done." } });
process.stdout.write(JSON.stringify({ type: "turn.completed" }));
`;
