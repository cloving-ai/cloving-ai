export const watchTranscriptClient = `
const transcripts = {};
const transcriptWindow = 2000;
let transcriptDrawing = false;
let transcriptRound = 0;
let transcriptTab = "transcript";
function transcriptItem(target) {
  if (!Object.hasOwn(transcripts, target.operationId))
    transcripts[target.operationId] = { runId: target.runId, shown: null, expanded: false, entries: [], state: "loading", message: "", earlier: false, unseen: 0, following: true, detached: false, latest: 0, source: null };
  return transcripts[target.operationId];
}
function transcriptPath(item, operationId, route) {
  return "api/v1/runs/" + encodeURIComponent(item.runId) + "/turns/" + encodeURIComponent(operationId) + "/" + route;
}
function transcriptRedraw() {
  if (transcriptDrawing) return;
  transcriptDrawing = true;
  setTimeout(() => { transcriptDrawing = false; draw(); }, 50);
}
function transcriptReplaced(entries, entry) {
  const kept = entry.replaceId === undefined ? entries : entries.filter((previous) => previous.attempt !== entry.attempt || previous.replaceId !== entry.replaceId);
  if (!entry.removed) kept.push(entry);
  return kept;
}
function transcriptReceived(item, entry) {
  if (entry.position <= item.latest) return;
  item.latest = entry.position;
  if (item.state === "loading") item.state = "open";
  if (item.detached || !item.following) item.unseen += 1;
  transcriptRedraw();
  if (item.detached) return;
  item.entries = transcriptReplaced(item.entries, entry);
  if (item.entries.length <= transcriptWindow) return;
  item.entries.splice(0, item.entries.length - transcriptWindow);
  item.earlier = true;
}
function transcriptStopped(item, problem) {
  item.source?.close();
  item.source = null;
  item.state = problem.code === "transcript-not-kept" ? "not-kept" : "failed";
  item.message = problem.detail;
}
async function transcriptRefused(item, operationId) {
  try {
    const reply = await fetch(transcriptPath(item, operationId, "transcript") + "?after=" + item.latest, { cache: "no-store" });
    if (!reply.ok) transcriptStopped(item, await reply.json());
  } catch {
    transcriptStopped(item, { code: "failed", detail: "The watch tool does not answer." });
  }
  draw();
}
function transcriptOpened(item, operationId) {
  if (item.source !== null || (item.state !== "loading" && item.state !== "open")) return;
  const source = new EventSource(transcriptPath(item, operationId, "transcript-stream") + "?after=" + item.latest);
  item.source = source;
  source.addEventListener("entry", (event) => { transcriptReceived(item, JSON.parse(event.data)); });
  source.addEventListener("refused", (event) => {
    transcriptStopped(item, JSON.parse(event.data));
    transcriptRedraw();
  });
  source.addEventListener("end", () => {
    source.close();
    item.source = null;
    item.state = "ended";
    transcriptRedraw();
  });
  source.onerror = () => {
    if (source.readyState !== 2 || item.source !== source) return;
    item.source = null;
    transcriptRefused(item, operationId);
  };
}
function transcriptClosed(item) {
  item.source?.close();
  item.source = null;
}
async function transcriptEarlier(target) {
  const item = transcriptItem(target);
  if (item.earlierLoading) return;
  item.earlierLoading = true;
  const first = item.entries[0]?.position ?? item.latest + 1;
  let found = [];
  let earlier = false;
  try {
    const reply = await fetch(transcriptPath(item, target.operationId, "transcript") + "?before=" + first, { cache: "no-store" });
    if (!reply.ok) return;
    const page = await reply.json();
    for (const entry of page.entries.filter((entry) => entry.position < first)) found = transcriptReplaced(found, entry);
    earlier = page.hasEarlier === true;
  } catch {} finally { item.earlierLoading = false; }
  item.entries = item.entries.reduce(transcriptReplaced, found);
  if (item.entries.length > transcriptWindow) {
    item.entries = item.entries.slice(0, transcriptWindow);
    item.detached = true;
  }
  item.earlier = earlier;
  draw();
}
function transcriptBox(operationId) {
  const boxes = document.querySelectorAll?.("[data-transcript]") ?? [];
  return [...boxes].find((box) => box.getAttribute("data-transcript") === operationId);
}
function transcriptPaged(item) {
  return item.expanded && watchLocation(location.hash.slice(1)).view !== "terminal";
}
function transcriptEndSeen(box) {
  return (box.getBoundingClientRect?.().bottom ?? 0) <= innerHeight + 24;
}
function transcriptPageScrolled() {
  let changed = false;
  for (const [operationId, item] of Object.entries(transcripts)) {
    const box = transcriptPaged(item) ? transcriptBox(operationId) : undefined;
    if (box === undefined) continue;
    item.following = transcriptEndSeen(box);
    if (item.following && item.unseen > 0 && !item.detached) { item.unseen = 0; changed = true; }
  }
  if (changed) draw();
}
addEventListener("scroll", transcriptPageScrolled, { passive: true });
function transcriptJumped(target) {
  const item = transcriptItem(target);
  item.unseen = 0;
  item.following = true;
  if (transcriptPaged(item)) transcriptBox(target.operationId)?.scrollIntoView({ block: "end" });
  if (!item.detached) { draw(); return; }
  transcriptClosed(item);
  item.detached = false;
  item.entries = [];
  item.latest = 0;
  item.earlier = false;
  item.state = "loading";
  transcriptOpened(item, target.operationId);
  draw();
}
function transcriptRetried(target) {
  const item = transcriptItem(target);
  item.state = "loading";
  item.message = "";
  transcriptOpened(item, target.operationId);
  draw();
}
function transcriptControls() {
  transcriptRound += 1;
  return {
    tab: transcriptTab,
    onTab(tab) {
      transcriptTab = tab;
      draw();
    },
    view(target) {
      const item = transcriptItem(target);
      item.round = transcriptRound;
      const shown = item.shown ?? target.wanted;
      if (shown) transcriptOpened(item, target.operationId);
      return { shown, expanded: transcriptPaged(item), entries: item.entries, state: item.state, message: item.message, earlier: item.earlier, unseen: item.unseen, detached: item.detached };
    },
    onToggle(target) {
      const item = transcriptItem(target);
      item.shown = !(item.shown ?? target.wanted);
      if (!item.shown) transcriptClosed(item);
      draw();
    },
    onExpand(target) {
      const item = transcriptItem(target);
      item.expanded = !item.expanded;
      draw();
    },
    onLink(target) {
      transcriptItem(target).shown = true;
      state.turnShown = null;
      transcriptRedraw();
    },
    onScroll(operationId, box) {
      const item = transcripts[operationId];
      if (item === undefined || transcriptPaged(item)) return;
      item.following = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
      if (item.following && item.unseen > 0 && !item.detached) { item.unseen = 0; draw(); }
    },
    onJump: transcriptJumped,
    onEarlier: transcriptEarlier,
    onRetry: transcriptRetried,
  };
}
function transcriptsFollowed(selected) {
  for (const [operationId, item] of Object.entries(transcripts)) {
    if (item.round === transcriptRound) continue;
    transcriptClosed(item);
    delete transcripts[operationId];
  }
  const boxes = document.querySelectorAll?.("[data-transcript]") ?? [];
  for (const box of boxes) {
    const item = transcripts[box.getAttribute("data-transcript")];
    if (item !== undefined && transcriptPaged(item)) item.following = transcriptEndSeen(box);
    else if (item?.following && !item.detached) box.scrollTop = box.scrollHeight;
  }
  const { turnId } = watchLocation(selected);
  if (turnId === null || turnId === undefined) { state.turnShown = null; state.turnTabbed = null; return; }
  const linked = state.turnTabbed !== selected;
  state.turnTabbed = selected;
  if (linked && transcriptTab !== "transcript") { transcriptTab = "transcript"; transcriptRedraw(); return; }
  if (state.turnShown === selected) return;
  const section = [...(document.querySelectorAll?.("[data-turn]") ?? [])].find((node) => node.getAttribute("data-turn") === turnId);
  if (section === undefined) return;
  state.turnShown = selected;
  if (transcripts[turnId]?.shown === false) { transcripts[turnId].shown = true; transcriptRedraw(); }
  section.scrollIntoView({ block: "start" });
}
`;
