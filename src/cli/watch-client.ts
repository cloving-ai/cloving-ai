export const watchClient = `
const state = { model: null, receivedAt: 0, stale: false, copied: "", label: "", run: "", loading: false, again: false, columns: {}, cards: {}, hovered: null, focused: null, phonePairing: null, phoneBusy: false, phoneMessage: "", phone: null, phoneLoadedAt: 0, phoneAccepted: null, phoneSequence: 0, phoneApplied: 0, queueBusy: false, queueMessage: "", continueBusy: [], continueMessages: {}, continueOpen: null, continueNote: "", steerOpen: null, steerNote: "", steerNow: false, steerBusy: [], steerMessages: {}, renameOpen: null, renameDrafts: {}, renameBusy: [], renameMessages: {}, renameCommands: {}, themeChoice: null, loopBusy: [], loopMessages: {}, loopCommands: {}, runCommandBusy: [], runCommandMessages: {}, runCommandSent: {}, runCommandAsking: null };
function readPreference(key) {
  try { return JSON.parse(localStorage.getItem(key)); }
  catch { return null; }
}
function readColumnChoices(key) {
  const value = readPreference(key);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([, choice]) => typeof choice === "boolean"));
}
function savePreference(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch {}
}
const darkScheme = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(theme) {
  const root = document.documentElement;
  const wanted = { "data-theme": theme?.name ?? null, "data-scheme": theme?.colorScheme ?? null, class: theme?.classes.join(" ") || null };
  for (const [name, value] of Object.entries(wanted)) {
    if (root.getAttribute(name) === value) continue;
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }
}
function themeControls() {
  const stored = state.themeChoice ?? readPreference("cloving.watch.theme");
  const shown = shownTheme(themes, { choice: typeof stored === "string" ? stored : null, dark: darkScheme.matches });
  applyTheme(shown.theme);
  return { shown, themes: themes.themes, onChoose(name) {
    state.themeChoice = name;
    savePreference("cloving.watch.theme", name);
    draw();
  } };
}
function columnControls(model, selected) {
  const workflowId = model === null ? null : boardWorkflow(model, watchLocation(selected).workflowId);
  if (workflowId === null) return undefined;
  const key = "cloving.watch.columns:" + workflowId;
  if (!Object.hasOwn(state.columns, workflowId))
    state.columns = { ...state.columns, [workflowId]: readColumnChoices(key) };
  const choices = state.columns[workflowId];
  return { choices, onHover(name) { state.hovered = name; }, onFocus(name) { state.focused = name; }, onToggle(name) {
    const changed = { ...choices, [name]: !columnCollapsed(choices, name) };
    state.columns = { ...state.columns, [workflowId]: changed };
    savePreference(key, changed);
    draw();
  } };
}
async function queuePost(command) {
  state.queueBusy = true;
  state.queueMessage = "";
  draw();
  try {
    const response = await fetch("actions/queue", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloving-token": actionToken },
      body: JSON.stringify({ command }),
    });
    const reply = response.ok ? await response.json() : { error: { detail: "The watch page refused the request. Refresh the page." } };
    state.queueMessage = reply.error?.detail ?? "";
  } catch {
    state.queueMessage = "The watch tool does not answer.";
  }
  state.queueBusy = false;
  await load();
}
function queueControls() {
  if (actionToken === null) return undefined;
  return { busy: state.queueBusy, message: state.queueMessage, onCommand: queuePost };
}
function continueMessage(reply) {
  if (reply.error) return reply.error.code + ": " + reply.error.detail;
  return "Run " + reply.runId + " continues this run.";
}
function dismissMessage(reply) {
  if (reply.error) return reply.error.code + ": " + reply.error.detail;
  return "The run is dismissed.";
}
function runRequest(runId, note) {
  return { method: "POST", headers: { "content-type": "application/json", "x-cloving-token": actionToken }, body: JSON.stringify(note === undefined ? { runId } : { runId, note }) };
}
async function runPost(runId, post) {
  if (state.continueBusy.includes(runId)) return;
  state.continueBusy = [...state.continueBusy, runId];
  draw();
  let message;
  try {
    message = await post();
  } catch {
    message = "The watch tool does not answer.";
  }
  state.continueBusy = state.continueBusy.filter((busy) => busy !== runId);
  state.continueMessages = { ...state.continueMessages, [runId]: message };
  await load();
}
const refusedRequest = "The watch page refused the request. Refresh the page.";
function continueOpen(runId) {
  state.continueOpen = runId;
  state.continueNote = "";
  draw();
  document.querySelector(".need-note input")?.focus();
}
function continueClose() {
  state.continueOpen = null;
  draw();
  document.querySelector(".need-continue")?.focus();
}
function continueNote(text) {
  state.continueNote = text;
}
function continuePost(runId) {
  const note = state.continueNote.trim() === "" ? undefined : state.continueNote;
  state.continueOpen = null;
  return runPost(runId, async () => {
    const response = await fetch("actions/continue", runRequest(runId, note));
    return response.ok ? continueMessage(await response.json()) : refusedRequest;
  });
}
function dismissPost(runId) {
  return runPost(runId, async () => {
    const response = await fetch("actions/dismiss", runRequest(runId));
    return response.ok ? dismissMessage(await response.json()) : refusedRequest;
  });
}
function continueControls() {
  if (actionToken === null) return undefined;
  return { busy: state.continueBusy, messages: state.continueMessages, open: state.continueOpen, note: state.continueNote, onOpen: continueOpen, onClose: continueClose, onNote: continueNote, onContinue: continuePost, onDismiss: dismissPost };
}
function steerMessage(reply) {
  if (reply.error) return reply.error.code + ": " + reply.error.detail;
  if (reply.delivery === "now") return "The turn in work got the note.";
  if (reply.reason !== undefined) return "The note waits for the next turn (queued: " + reply.reason + ").";
  return "The note waits for the next turn (queued).";
}
function steerOpen(runId) {
  state.steerOpen = runId;
  state.steerNote = "";
  state.steerNow = false;
  draw();
  document.querySelector(".steer-form textarea")?.focus();
}
function steerClose() {
  state.steerOpen = null;
  draw();
  document.querySelector(".steer-open")?.focus();
}
function steerNote(text) {
  state.steerNote = text;
}
function steerNow(choice) {
  state.steerNow = choice.now;
}
async function steerPost(runId) {
  if (state.steerBusy.includes(runId)) return;
  const body = JSON.stringify({ runId, note: state.steerNote, now: state.steerNow });
  state.steerOpen = null;
  state.steerBusy = [...state.steerBusy, runId];
  draw();
  let message = refusedRequest;
  try {
    const response = await fetch("actions/steer", { method: "POST", headers: { "content-type": "application/json", "x-cloving-token": actionToken }, body });
    if (response.ok) message = steerMessage(await response.json());
  } catch {
    message = refusedRequest;
  }
  state.steerBusy = state.steerBusy.filter((busy) => busy !== runId);
  state.steerMessages = { ...state.steerMessages, [runId]: message };
  await load();
}
function steerControls() {
  if (actionToken === null) return undefined;
  return { open: state.steerOpen, note: state.steerNote, now: state.steerNow, busy: state.steerBusy, messages: state.steerMessages, onOpen: steerOpen, onClose: steerClose, onNote: steerNote, onNow: steerNow, onSend: steerPost };
}
function renameMessage(reply) {
  if (reply.error) return reply.error.code + ": " + reply.error.detail;
  return "The run has the title " + reply.title + ".";
}
function renameOpen(target) {
  const draft = state.renameDrafts[target.runId] ?? { title: target.title, label: target.label };
  state.renameOpen = target.runId;
  state.renameDrafts = { ...state.renameDrafts, [target.runId]: draft };
  draw();
  document.querySelector(".rename-form input")?.focus();
}
function renameDropped(runId) {
  const { [runId]: dropped, ...kept } = state.renameDrafts;
  return kept;
}
function renameClose() {
  state.renameDrafts = renameDropped(state.renameOpen);
  state.renameOpen = null;
  draw();
  document.querySelector(".rename-open")?.focus();
}
function renameEdit(change) {
  const runId = state.renameOpen;
  state.renameDrafts = { ...state.renameDrafts, [runId]: { ...state.renameDrafts[runId], ...change } };
}
const renameLate = { message: "The watch tool does not answer. Save again to send the same command.", answered: false, saved: false };
async function renameReply(body) {
  try {
    const response = await fetch("actions/rename", { method: "POST", headers: { "content-type": "application/json", "x-cloving-token": actionToken }, body });
    if (response.status === 503) return renameLate;
    if (!response.ok) return { message: refusedRequest, answered: true, saved: false };
    const reply = await response.json();
    return { message: renameMessage(reply), answered: true, saved: !reply.error };
  } catch {
    return renameLate;
  }
}
async function renamePost(runId, fields) {
  if (state.renameBusy.includes(runId)) return;
  const control = JSON.stringify([runId, fields]);
  const commandId = state.renameCommands[control] ?? crypto.randomUUID();
  state.renameCommands = { ...state.renameCommands, [control]: commandId };
  state.renameOpen = null;
  state.renameBusy = [...state.renameBusy, runId];
  draw();
  const outcome = await renameReply(JSON.stringify({ runId, ...fields, commandId }));
  const { [control]: answered, ...others } = state.renameCommands;
  if (outcome.answered) state.renameCommands = others;
  if (outcome.saved) state.renameDrafts = renameDropped(runId);
  if (!outcome.saved && fields.title !== undefined && state.renameOpen === null) state.renameOpen = runId;
  state.renameBusy = state.renameBusy.filter((busy) => busy !== runId);
  state.renameMessages = { ...state.renameMessages, [runId]: outcome.message };
  await load();
}
function renameSave(runId) {
  const draft = state.renameDrafts[runId];
  const label = draft.label.trim();
  return renamePost(runId, label === "" ? { title: draft.title } : { title: draft.title, label });
}
function renameControls() {
  if (actionToken === null) return undefined;
  const draft = state.renameDrafts[state.renameOpen] ?? { title: "", label: "" };
  return { open: state.renameOpen, title: draft.title, label: draft.label, busy: state.renameBusy, messages: state.renameMessages, onOpen: renameOpen, onClose: renameClose, onTitle(text) { renameEdit({ title: text }); }, onLabel(text) { renameEdit({ label: text }); }, onSave: renameSave, onClear(runId) { return renamePost(runId, { clear: true }); } };
}
function moved(next, followed) {
  const arrived = next === "waiting_gate" && next !== state.run;
  state.run = next;
  if (arrived) scrollTo(0, 0);
  else if (followed && next === "running") scrollTo(0, document.body.scrollHeight);
}
function copy(command) {
  const shown = (label) => {
    state.copied = command;
    state.label = label;
    draw();
  };
  navigator.clipboard.writeText(command).then(
    () => { shown("Copied"); },
    () => { shown("Copy failed"); },
  );
}
function draw() {
  const { model, stale } = state;
  const selected = location.hash.slice(1);
  const followed = innerHeight + scrollY >= document.body.scrollHeight - 80;
  const copying = { command: state.copied, label: state.label, onCopy: copy };
  const now = new Date().toISOString();
  const observationNow = model === null ? now : new Date(Date.parse(model.updatedAt) + performance.now() - state.receivedAt).toISOString();
  const columns = columnControls(model, selected);
  const cards = cardControls(model, model === null ? null : boardWorkflow(model, watchLocation(selected).workflowId));
  const phone = model === null ? undefined : phoneControls(now);
  const queue = queueControls();
  const continuing = continueControls();
  const steering = steerControls();
  const deciding = decisionControls();
  const controlling = runCommandControls();
  const renaming = renameControls();
  const theme = themeControls();
  const loops = loopControls();
  const transcripts = transcriptControls();
  const page = component(Page, { model, selected, now, observationNow, stale, copying, columns, cards, phone, queue, continuing, deciding, steering, controlling, renaming, loops, theme, transcripts });
  render(page, document.getElementById("app"));
  if (model === null) return;
  transcriptsFollowed(selected);
  document.title = watchTitle(model, selected);
  const { runId } = watchLocation(selected);
  moved(model.runs.find((run) => run.runId === runId)?.state ?? "", followed);
  decisionFollowed(selected);
}
async function withSelectedRun(model) {
  const { runId } = watchLocation(location.hash);
  if (runId === null || model.runs.some((run) => run.runId === runId)) return model;
  const detail = await fetch("data.json?runId=" + encodeURIComponent(runId), { cache: "no-store" });
  if (detail.status === 404) return model;
  if (!detail.ok) throw new Error("watch-run-not-available");
  const { run } = await detail.json();
  if (run?.runId !== runId) throw new Error("watch-run-mismatch");
  return { ...model, runs: [...model.runs, { ...run, linked: true }] };
}
async function load() {
  state.again = state.loading;
  if (state.loading) return;
  state.loading = true;
  try {
    const reply = await fetch("data.json", { cache: "no-store" });
    if (!reply.ok) throw new Error("watch-not-available");
    const model = await reply.json();
    const receivedAt = performance.now();
    state.model = await withSelectedRun(model);
    state.receivedAt = receivedAt;
    state.stale = false;
  } catch {
    state.stale = true;
  }
  state.loading = false;
  draw();
  if (state.again) load();
}
function listen() {
  const source = new EventSource("events");
  source.onmessage = () => { load(); };
  source.onerror = () => { state.stale = true; draw(); };
}
addEventListener("keydown", (event) => {
  if (event.key !== String.fromCharCode(92) || event.defaultPrevented || event.repeat || event.isComposing) return;
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  if (event.target?.closest?.("input, textarea, select, [contenteditable]")) return;
  const target = state.hovered ?? state.focused;
  if (target === null || watchLocation(location.hash).runId !== null) return;
  const controls = columnControls(state.model, location.hash);
  if (controls === undefined) return;
  event.preventDefault();
  controls.onToggle(target);
});
darkScheme.addEventListener("change", draw);
addEventListener("hashchange", () => { state.run = ""; state.hovered = null; state.focused = null; decisionState.focused = ""; draw(); load(); });
draw();
listen();
setInterval(draw, 1000);
setInterval(load, 15000);
if (actionToken !== null) {
  phoneLoad();
  setInterval(phoneLoad, 2000);
}
`;
