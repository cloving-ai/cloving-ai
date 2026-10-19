export const watchCardClient = `
async function submitCard(workflowId) {
  const draft = state.cards[workflowId];
  if (!draft || draft.pending || draft.admitted) return;
  state.cards[workflowId] = { ...draft, pending: true, message: "" };
  draw();
  let result;
  try {
    const response = await fetch("actions/run", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloving-token": actionToken },
      body: JSON.stringify({ workflowId, fields: draft.fields, commandId: draft.commandId }),
    });
    result = response.ok ? cardReply(await response.json()) : { admitted: false, message: "request-refused: Refresh the page and check the input (16 KiB maximum)." };
  } catch {
    result = cardReply({ kind: "error", error: { code: "outcome-unknown" } });
  }
  if (state.cards[workflowId]?.commandId !== draft.commandId) return;
  state.cards[workflowId] = { ...draft, ...result, pending: false };
  draw();
}

function cardControls(model, workflowId) {
  if (actionToken === null || workflowId === null) return undefined;
  const form = model?.cardForms?.find((item) => item.workflowId === workflowId);
  if (form === undefined) return undefined;
  const draft = state.cards[workflowId] ?? null;
  return { draft, onOpen() {
    state.cards[workflowId] = { commandId: crypto.randomUUID(), fields: {}, pending: false, admitted: false, message: "" };
    draw();
    document.querySelector(".add-card-form input, .add-card-form textarea, .add-card-form button")?.focus();
  }, onCancel() {
    delete state.cards[workflowId];
    draw();
    document.querySelector(".add-card")?.focus();
  },
  onChange(name, value) {
    state.cards[workflowId] = { ...state.cards[workflowId], fields: { ...state.cards[workflowId].fields, [name]: value } };
  }, onSubmit() { submitCard(workflowId); } };
}
`;
