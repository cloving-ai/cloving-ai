export const watchPhoneClient = `
async function phoneLoad() {
  const sent = Date.now();
  const sequence = ++state.phoneSequence;
  try {
    const reply = await fetch("phone.json", { cache: "no-store" });
    const phone = reply.ok ? await reply.json() : null;
    if (phone !== null && sequence > state.phoneApplied) {
      state.phoneApplied = sequence;
      state.phone = phone;
      state.phoneLoadedAt = sent;
    }
  } catch {}
  draw();
}
async function phonePost(action, body = {}) {
  state.phoneBusy = true;
  state.phoneMessage = "";
  draw();
  let reply;
  try {
    const response = await fetch("actions/phone/" + action, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloving-token": actionToken },
      body: JSON.stringify(body),
    });
    reply = response.ok ? await response.json() : { error: { detail: "The watch page refused the request. Refresh the page." } };
  } catch {
    reply = { error: { detail: "The watch tool does not answer." } };
  }
  state.phoneBusy = false;
  state.phoneMessage = reply.error?.detail ?? reply.warning ?? "";
  return reply;
}
function phoneSession(now) {
  const pairing = state.phonePairing;
  const live = state.phone?.pairing ?? null;
  const ended = live === null && state.phoneLoadedAt > (pairing?.at ?? 0);
  if (pairing !== null && (ended || Date.parse(pairing.expiresAt) <= Date.parse(now))) state.phonePairing = null;
  const accepted = state.phoneAccepted;
  const device = (state.phone?.devices ?? []).find((item) => item.deviceId === accepted?.deviceId);
  const shown = device?.state === "connected" && device.removedAt === null;
  return { live, connected: shown ? device.name : null };
}
function phoneControls(now) {
  if (actionToken === null) return undefined;
  const { live, connected } = phoneSession(now);
  return {
    pairing: state.phonePairing,
    request: live?.request ?? null,
    stage: live?.stage ?? null,
    connected,
    refusal: state.phone?.refusal ?? null,
    reason: state.phone?.reason ?? null,
    devices: state.phone?.devices ?? [],
    busy: state.phoneBusy,
    message: state.phoneMessage,
    async onPair() {
      state.phoneAccepted = null;
      const reply = await phonePost("pair");
      if (!reply.error) state.phonePairing = { ...reply, at: Date.now() };
      await phoneLoad();
    },
    async onCancel() {
      state.phonePairing = null;
      await phonePost("cancel");
      await phoneLoad();
    },
    async onAccept() {
      state.phoneAccepted = live?.request ?? null;
      await phonePost("accept", { pairingId: live?.pairingId });
      await phoneLoad();
    },
    async onDeny() {
      await phonePost("deny", { pairingId: live?.pairingId });
      await phoneLoad();
    },
    async onRemove(deviceId) {
      await phonePost("remove", { deviceId });
      await phoneLoad();
    },
  };
}
`;
