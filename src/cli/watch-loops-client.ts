export const watchLoopsClient = `
async function loopPost(workflowId, action) {
  if (state.loopBusy.includes(workflowId)) return;
  const control = action + " " + workflowId;
  const commandId = state.loopCommands[control] ?? crypto.randomUUID();
  state.loopCommands = { ...state.loopCommands, [control]: commandId };
  state.loopBusy = [...state.loopBusy, workflowId];
  draw();
  let message;
  try {
    const response = await fetch("actions/schedule", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloving-token": actionToken },
      body: JSON.stringify({ workflowId, action, commandId }),
    });
    if (response.status === 503) throw new Error("late");
    const reply = response.ok ? await response.json() : null;
    message = reply === null ? refusedRequest : loopMessage(reply);
    if (reply?.error?.code !== "outcome-unknown") {
      const { [control]: answered, ...others } = state.loopCommands;
      state.loopCommands = others;
    }
  } catch {
    message = "The watch tool does not answer. Click again to send the same command.";
  }
  state.loopBusy = state.loopBusy.filter((busy) => busy !== workflowId);
  state.loopMessages = { ...state.loopMessages, [workflowId]: message };
  await load();
}
function loopControls() {
  if (actionToken === null) return undefined;
  return { busy: state.loopBusy, messages: state.loopMessages, onSwitch: loopPost, onRun(workflowId) { loopPost(workflowId, "run"); } };
}
`;
