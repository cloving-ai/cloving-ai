export const watchLoopsClient = `
async function loopPost(workflowId, action) {
  if (state.loopBusy.includes(workflowId)) return;
  const known = state.loopCommands[workflowId];
  const commandId = known?.action === action ? known.commandId : crypto.randomUUID();
  state.loopCommands = { ...state.loopCommands, [workflowId]: { action, commandId } };
  state.loopBusy = [...state.loopBusy, workflowId];
  draw();
  let message;
  try {
    const response = await fetch("actions/schedule", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloving-token": actionToken },
      body: JSON.stringify({ workflowId, action, commandId }),
    });
    message = response.ok ? loopMessage(await response.json()) : refusedRequest;
    const { [workflowId]: sent, ...others } = state.loopCommands;
    state.loopCommands = others;
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
