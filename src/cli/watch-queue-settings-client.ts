export const watchQueueSettingsClient = `
function settingKey(change) { return change.scope === "global" ? "@global" : change.workflowId; }
function settingQueue(model, change) { return change.scope === "global" ? model?.globalQueue : model?.queues?.find(queue => queue.workflowId === change.workflowId); }
function settingValues(queue, change) {
  if (!queue) return null;
  return change.scope === "global"
    ? [queue.lanes, queue.workingLanes, queue.configuredLanes, queue.configuredWorkingLanes, queue.sources]
    : [queue.lanes, queue.settings?.workingLanes?.value, queue.settings];
}
function settingConfirmed(queue, change) {
  const pair = settingValues(queue, change);
  if (!pair || !Number.isSafeInteger(pair[0]) || !Number.isSafeInteger(pair[1]) || pair[0] < 1 || pair[0] > 16 || pair[1] < 1 || pair[1] > pair[0]) return false;
  if (change.action === "inherit") {
    const source = change.scope === "global" ? queue.sources?.[change.field] : queue.settings?.[change.field]?.source;
    return typeof source === "string" && !source.includes("private file");
  }
  return (change.field === "lanes" ? pair[0] : pair[1]) === change.value;
}
function queueSettingRetry(key) {
  const saved = state.queueSettings?.[key];
  if (saved) return queueSettingPost(saved.change, true);
}
async function queueSettingPost(change, retry = false) {
  const key = settingKey(change);
  if (state.queueBusy.includes(key)) return;
  state.queueSettings ??= {};
  const saved = state.queueSettings[key];
  if (saved && !retry) {
    state.queueMessages = { ...state.queueMessages, [key]: "A previous result is unknown. Retry the same request to resolve it before changing this queue." };
    draw(); return;
  }
  const command = saved?.command ?? { ...change, commandId: crypto.randomUUID() };
  const previousWorking = settingValues(settingQueue(state.model, change), change)?.[1];
  state.queueSettings = { ...state.queueSettings, [key]: { change, command } };
  state.queueBusy = [...state.queueBusy, key];
  state.queueAcknowledged = { ...state.queueAcknowledged, [key]: null };
  state.queueMessages = { ...state.queueMessages, [key]: "Saving…" }; draw();
  let reply;
  let message = "The result is unknown. Retry the same request to read the effective running limits.";
  try {
    const response = await fetch("actions/queue-settings", { method: "POST", headers: { "content-type": "application/json", "x-cloving-token": actionToken }, body: JSON.stringify(command) });
    if (response.status === 503) throw new Error("outcome-unknown");
    reply = response.ok ? await response.json() : null;
    if (reply?.error?.code !== "outcome-unknown" && reply?.error?.saved !== true && reply !== null) {
      const { [key]: answered, ...others } = state.queueSettings;
      state.queueSettings = others;
    }
    message = reply?.error?.detail ?? "The change was not confirmed. Refresh and check the effective limits before retrying.";
    if (reply?.kind === "queue-setting" && reply.commandId === command.commandId) {
      state.queueMessages = { ...state.queueMessages, [key]: "Applying…" }; draw();
    }
  } catch {}
  const fresh = await load();
  const effective = settingQueue(state.model, change);
  const returned = settingQueue(reply, change);
  if (reply?.kind === "queue-setting" && reply.commandId === command.commandId && fresh && settingConfirmed(returned, change) && JSON.stringify(settingValues(effective, change)) === JSON.stringify(settingValues(returned, change))) {
    message = "";
    const working = settingValues(effective, change)[1];
    const text = previousWorking > working ? "✓ Saved · active-work cap adjusted to " + working : "✓ Saved";
    state.queueAcknowledged = { ...state.queueAcknowledged, [key]: { until: performance.now() + 2200, text } };
  }
  state.queueBusy = state.queueBusy.filter(id => id !== key);
  state.queueMessages = { ...state.queueMessages, [key]: message }; draw();
}
function queueSettingControls() {
  const acknowledgements = Object.fromEntries(Object.entries(state.queueAcknowledged ?? {}).flatMap(([key, value]) => value && value.until > performance.now() ? [[key, value.text]] : []));
  return { acknowledgements, retry: Object.keys(state.queueSettings ?? {}), onRetry: queueSettingRetry, onSetting: queueSettingPost };
}
`;
