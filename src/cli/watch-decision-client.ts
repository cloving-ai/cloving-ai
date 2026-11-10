export const watchDecisionClient = `
const decisionState = { busy: [], messages: {}, answers: {}, commands: {}, focused: "" };
const decisionRetry = "The watch tool does not answer. Click again to send the same request.";
function decisionMessage(reply, kind) {
  if (reply.kind !== "error") return { approve: "Approved", deny: "Denied", answer: "Answer sent" }[kind];
  if (["stale-revision", "stale-generation", "subject-mismatch"].includes(reply.code)) return "The decision changed. Read it again.";
  return reply.code + ": " + reply.detail;
}
function decisionAnswer(answer) {
  decisionState.answers = { ...decisionState.answers, [answer.decisionId]: answer.text };
}
function decisionRunId(decisionId) {
  return state.model?.runs.find((run) => run.decisions.some((item) => item.decisionId === decisionId))?.runId ?? decisionId;
}
function decisionShown(runId, message) {
  decisionState.messages = { ...decisionState.messages, [runId]: message };
}
function decisionBody(decision, reply) {
  const body = { command: reply, reference: decision.reference, expectedRevision: decision.expectedRevision, generation: decision.generation, subjectDigest: decision.subjectDigest };
  if (reply !== "answer") return body;
  return { ...body, text: (decisionState.answers[decision.decisionId] ?? "").trim() };
}
async function decisionSent(body, commandId) {
  try {
    const response = await fetch("actions/decision", { method: "POST", headers: { "content-type": "application/json", "x-cloving-token": actionToken }, body: JSON.stringify({ ...body, commandId }) });
    if (!response.ok) return { message: refusedRequest, kept: true };
    const reply = await response.json();
    return { message: decisionMessage(reply, body.command), kept: ["outcome-unknown", "service-unavailable"].includes(reply.code) };
  } catch {
    return { message: decisionRetry, kept: true };
  }
}
async function decisionPost(choice) {
  const { decision, reply } = choice;
  const id = decision.decisionId;
  if (decisionState.busy.includes(id)) return;
  const runId = decisionRunId(id);
  const body = decisionBody(decision, reply);
  if (body.text !== undefined && (body.text === "" || Array.from(body.text).length > 4000)) {
    decisionShown(runId, "Write an answer of 1 to 4000 characters.");
    draw();
    return;
  }
  const key = JSON.stringify(body);
  const commandId = decisionState.commands[key] ?? crypto.randomUUID();
  decisionState.commands = { ...decisionState.commands, [key]: commandId };
  decisionState.busy = [...decisionState.busy, id];
  draw();
  const sent = await decisionSent(body, commandId);
  if (!sent.kept) decisionState.commands = Object.fromEntries(Object.entries(decisionState.commands).filter(([given]) => given !== key));
  if (sent.message === "Answer sent") decisionAnswer({ decisionId: id, text: "" });
  decisionState.busy = decisionState.busy.filter((busy) => busy !== id);
  decisionShown(runId, sent.message);
  await load();
}
function decisionControls() {
  if (actionToken === null) return undefined;
  return { busy: decisionState.busy, messages: decisionState.messages, answers: decisionState.answers, onAnswer: decisionAnswer, onReply: decisionPost };
}
function decisionFollowed(selected) {
  const { decisionId } = watchLocation(selected);
  if (decisionId === undefined || decisionState.focused === selected) return;
  const section = document.getElementById("decision-" + decisionId);
  if (section === null) return;
  decisionState.focused = selected;
  section.scrollIntoView?.({ block: "start" });
  (document.getElementById("answer-" + decisionId) ?? section.querySelector?.("button"))?.focus?.();
}
`;
