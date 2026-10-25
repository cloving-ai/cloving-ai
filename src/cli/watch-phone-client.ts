export const watchPhoneClient = `
async function phonePost(action) {
  state.phoneBusy = true;
  state.phoneMessage = "";
  draw();
  let reply;
  try {
    const response = await fetch("actions/phone/" + action, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloving-token": actionToken },
      body: "{}",
    });
    reply = response.ok ? await response.json() : { error: { detail: "The watch page refused the request. Refresh the page." } };
  } catch {
    reply = { error: { detail: "The watch tool does not answer." } };
  }
  state.phoneBusy = false;
  if (reply.error) state.phoneMessage = reply.error.detail;
  return reply;
}
function phoneControls(now) {
  if (actionToken === null) return undefined;
  const pairing = state.phonePairing;
  if (pairing !== null && Date.parse(pairing.expiresAt) <= Date.parse(now)) state.phonePairing = null;
  return {
    pairing: state.phonePairing,
    busy: state.phoneBusy,
    message: state.phoneMessage,
    async onPair() {
      const reply = await phonePost("pair");
      if (!reply.error) state.phonePairing = reply;
      draw();
    },
    async onCancel() {
      state.phonePairing = null;
      draw();
      await phonePost("cancel");
      draw();
    },
  };
}
`;
