export const watchQueueClient = `
function queueLaneMessage(reply, command, previousWorking) {
  const queue = reply.queue;
  const working = queue?.settings?.workingLanes?.value;
  if (queue?.workflowId !== command.workflowId || queue.lanes !== command.lanes || !Number.isSafeInteger(working) || working < 1 || working > command.lanes)
    return "The lane change was not confirmed by the running service. Refresh the page and check the effective limits before trying again.";
  const unit = (count) => count === 1 ? "lane" : "lanes";
  const adjustment = previousWorking > working ? " Active work cap adjusted; see Advanced." : "";
  return "Applied: " + queue.lanes + " " + unit(queue.lanes) + "." + adjustment;
}
function queueSnapshot(workflowId) {
  const queue = state.model?.queues?.find((queue) => queue.workflowId === workflowId);
  return JSON.stringify([queue?.state, queue?.lanes]);
}
async function queuePost(workflowId, requested) {
  if (state.queueBusy.includes(workflowId)) return;
  const request = JSON.stringify(requested);
  const saved = state.queueCommands[workflowId];
  const command = saved?.request === request ? saved.command : { ...requested, workflowId, commandId: crypto.randomUUID() };
  state.queueCommands = { ...state.queueCommands, [workflowId]: { request, command, shown: queueSnapshot(workflowId) } };
  state.queueBusy = [...state.queueBusy, workflowId];
  state.queueMessages = { ...state.queueMessages, [workflowId]: requested.command === "lanes" ? "Saving lane settings…" : "" };
  const previousWorking = state.model?.queues?.find((queue) => queue.workflowId === workflowId)?.settings?.workingLanes?.value;
  draw();
  let message;
  let effectiveWorking;
  try {
    const response = await fetch("actions/queue", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloving-token": actionToken },
      body: JSON.stringify(command),
    });
    if (response.status === 503) throw new Error("late");
    if (requested.command === "lanes" && response.ok) {
      state.queueMessages = { ...state.queueMessages, [workflowId]: "Applying: reading the effective running limits…" };
      draw();
    }
    const reply = response.ok ? await response.json() : null;
    effectiveWorking = reply?.queue?.settings?.workingLanes?.value;
    message = reply === null ? refusedRequest : reply.error?.detail ?? (requested.command === "lanes" ? queueLaneMessage(reply, command, previousWorking) : "");
    if (reply?.error?.code !== "outcome-unknown") {
      const { [workflowId]: answered, ...others } = state.queueCommands;
      state.queueCommands = others;
    }
  } catch {
    message = "The watch tool does not answer. Click again to send the same command.";
  }
  const fresh = await load();
  if (requested.command === "lanes" && message.startsWith("Applied:")) {
    const effective = state.model?.queues?.find((queue) => queue.workflowId === workflowId);
    message = fresh && effective?.settings?.workingLanes?.value === effectiveWorking
      ? queueLaneMessage({ queue: effective }, command, previousWorking)
      : "The lane change was not confirmed by the running service. Refresh the page and check the effective limits before trying again.";
  }
  state.queueBusy = state.queueBusy.filter((busy) => busy !== workflowId);
  state.queueMessages = { ...state.queueMessages, [workflowId]: message };
  draw();
}
function queueControls() {
  if (actionToken === null) return undefined;
  state.queueCommands = Object.fromEntries(Object.entries(state.queueCommands).filter(([id, saved]) => saved.shown === queueSnapshot(id)));
  return { busy: state.queueBusy, messages: state.queueMessages,
    ...queueSettingControls(),
    onCommand(workflowId, command) { queuePost(workflowId, { command }); },
    onLanes(workflowId, change) { queueSettingPost({ scope: "workflow", workflowId, field: "lanes", action: "set", value: change.lanes, expectedValue: change.expectedLanes }); },
  };
}
`;
