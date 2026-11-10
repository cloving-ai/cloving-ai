export const watchRunCommandClient = `
const runCommandWords = { pause: "Paused", resume: "Resumed", drop: "Dropped" };
function runCommandMessage(reply) {
  if (reply.error?.code === "stale-revision") return "The run changed. Look again and try again.";
  if (reply.error) return reply.error.code + ": " + reply.error.detail;
  return runCommandWords[reply.command] ?? "";
}
function runCommandFocus(runId, name) {
  draw();
  document.querySelector('.run-command[data-run="' + runId + '"] .' + name)?.focus();
}
function runCommandSent(control, runId) {
  const kept = state.runCommandSent[control];
  if (kept !== undefined) return kept;
  const expectedRevision = state.model?.runs.find((run) => run.runId === runId)?.revision;
  return { runId, expectedRevision, commandId: crypto.randomUUID() };
}
async function runCommandPost(runId, command) {
  if (state.runCommandBusy.includes(runId)) return;
  const control = command + " " + runId;
  const sent = runCommandSent(control, runId);
  state.runCommandSent = { ...state.runCommandSent, [control]: sent };
  state.runCommandAsking = null;
  state.runCommandBusy = [...state.runCommandBusy, runId];
  draw();
  let message;
  try {
    const response = await fetch("actions/" + command, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloving-token": actionToken },
      body: JSON.stringify(sent),
    });
    if (response.status === 503) throw new Error("late");
    const reply = response.ok ? await response.json() : null;
    message = reply === null ? refusedRequest : runCommandMessage(reply);
    if (reply?.error?.code !== "outcome-unknown") {
      const { [control]: answered, ...others } = state.runCommandSent;
      state.runCommandSent = others;
    }
  } catch {
    message = "The watch tool does not answer. Click again to send the same command.";
  }
  state.runCommandBusy = state.runCommandBusy.filter((busy) => busy !== runId);
  state.runCommandMessages = { ...state.runCommandMessages, [runId]: message };
  await load();
}
function runCommandControls() {
  if (actionToken === null) return undefined;
  return {
    busy: state.runCommandBusy,
    messages: state.runCommandMessages,
    asking: state.runCommandAsking,
    onCommand: runCommandPost,
    onAsk(runId) {
      state.runCommandAsking = runId;
      runCommandFocus(runId, "drop-keep");
    },
    onKeep() {
      const runId = state.runCommandAsking;
      state.runCommandAsking = null;
      runCommandFocus(runId, "run-command-drop");
    },
  };
}
`;
