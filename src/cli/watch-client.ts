export const watchClient = `
const state = { model: null, receivedAt: 0, stale: false, copied: "", label: "", run: "", loading: false, again: false, columns: {}, cards: {}, start: null, hovered: null, focused: null };
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
function startControls() {
  if (state.start === null) state.start = readPreference("cloving.watch.start") === true;
  return { shown: state.start, onToggle() {
    state.start = !state.start;
    savePreference("cloving.watch.start", state.start);
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
  const start = model === null ? undefined : startControls();
  const cards = cardControls(model, model === null ? null : boardWorkflow(model, watchLocation(selected).workflowId));
  const page = component(Page, { model, selected, now, observationNow, stale, copying, columns, start, cards });
  render(page, document.getElementById("app"));
  if (model === null) return;
  document.title = watchTitle(model, selected);
  const { runId } = watchLocation(selected);
  moved(model.runs.find((run) => run.runId === runId)?.state ?? "", followed);
}
async function withSelectedRun(model) {
  const { runId } = watchLocation(location.hash);
  if (runId === null || model.runs.some((run) => run.runId === runId)) return model;
  const detail = await fetch("data.json?runId=" + encodeURIComponent(runId), { cache: "no-store" });
  if (detail.status === 404) return model;
  if (!detail.ok) throw new Error("watch-run-not-available");
  const { run } = await detail.json();
  if (run?.runId !== runId) throw new Error("watch-run-mismatch");
  return { ...model, runs: [...model.runs, run] };
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
addEventListener("hashchange", () => { state.run = ""; state.hovered = null; state.focused = null; draw(); load(); });
draw();
listen();
setInterval(draw, 1000);
setInterval(load, 15000);
`;
