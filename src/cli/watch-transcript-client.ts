export const watchTranscriptClient = `
const transcripts = {};
const transcriptWindow = 2000;
let transcriptDrawing = false;
let transcriptRound = 0;
function transcriptItem(target) {
  if (!Object.hasOwn(transcripts, target.operationId))
    transcripts[target.operationId] = { runId: target.runId, shown: null, entries: [], state: "loading", message: "", earlier: false, unseen: 0, following: true, detached: false, latest: 0, source: null };
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
function transcriptReceived(item, entry) {
  if (entry.position <= item.latest) return;
  item.latest = entry.position;
  if (item.state === "loading") item.state = "open";
  if (item.detached || !item.following) item.unseen += 1;
  transcriptRedraw();
  if (item.detached) return;
  item.entries.push(entry);
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
    if (reply.ok) { item.source = null; transcriptOpened(item, operationId); return; }
    transcriptStopped(item, await reply.json());
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
  const first = item.entries[0]?.position ?? item.latest + 1;
  const found = [];
  let after = Math.max(0, first - 201);
  try {
    while (after < first - 1) {
      const reply = await fetch(transcriptPath(item, target.operationId, "transcript") + "?after=" + after, { cache: "no-store" });
      if (!reply.ok) break;
      const page = await reply.json();
      found.push(...page.entries.filter((entry) => entry.position < first));
      if (page.entries.length === 0) break;
      after = page.nextAfter;
    }
  } catch {}
  item.entries = [...found, ...item.entries];
  if (item.entries.length > transcriptWindow) {
    item.entries = item.entries.slice(0, transcriptWindow);
    item.detached = true;
  }
  item.earlier = (item.entries[0]?.position ?? 1) > 1;
  draw();
}
function transcriptJumped(target) {
  const item = transcriptItem(target);
  item.unseen = 0;
  item.following = true;
  if (!item.detached) { draw(); return; }
  transcriptClosed(item);
  item.detached = false;
  item.entries = [];
  item.latest = Math.max(0, item.latest - transcriptWindow);
  item.earlier = item.latest > 0;
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
    view(target) {
      const item = transcriptItem(target);
      item.round = transcriptRound;
      const shown = item.shown ?? target.wanted;
      if (shown) transcriptOpened(item, target.operationId);
      return { shown, entries: item.entries, state: item.state, message: item.message, earlier: item.earlier, unseen: item.unseen, detached: item.detached };
    },
    onToggle(target) {
      const item = transcriptItem(target);
      item.shown = !(item.shown ?? target.wanted);
      if (!item.shown) transcriptClosed(item);
      draw();
    },
    onScroll(operationId, box) {
      const item = transcripts[operationId];
      if (item === undefined) return;
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
    if (item?.following && !item.detached) box.scrollTop = box.scrollHeight;
  }
  const { turnId } = watchLocation(selected);
  if (turnId === null || turnId === undefined || state.turnShown === selected) return;
  const section = [...(document.querySelectorAll?.("[data-turn]") ?? [])].find((node) => node.getAttribute("data-turn") === turnId);
  if (section === undefined) return;
  state.turnShown = selected;
  if (transcripts[turnId]?.shown === false) { transcripts[turnId].shown = true; transcriptRedraw(); }
  section.scrollIntoView({ block: "start" });
}
`;
