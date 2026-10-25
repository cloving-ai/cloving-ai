import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface FakeDaemon {
  readonly daemonId: string;
  readonly token: string;
  readonly name: unknown;
  readonly agreementPublicKey: unknown;
  readonly signingPublicKey: unknown;
}

export interface FakePairing {
  readonly pairingId: string;
  readonly daemonId: string;
  stage: string;
  expiresAt: string;
  request: Readonly<Record<string, unknown>> | null;
  receipt: unknown;
  check: unknown;
}

export interface FakeRelayServer {
  readonly origin: string;
  readonly requests: RecordedRequest[];
  readonly daemons: FakeDaemon[];
  readonly pairings: Map<string, FakePairing>;
  readonly revoke: (token: string) => void;
  readonly change: (pairingId: string, update: Partial<FakePairing>) => void;
  readonly close: () => Promise<void>;
}

interface Settings {
  readonly pairingMilliseconds?: number;
  readonly receiptStatus?: number;
  readonly startDelayMilliseconds?: number;
  readonly registerDelayMilliseconds?: number;
}

interface FakeState {
  readonly settings: Settings;
  readonly requests: RecordedRequest[];
  readonly daemons: FakeDaemon[];
  readonly pairings: Map<string, FakePairing>;
  readonly revoked: Set<string>;
  readonly waiting: Set<() => void>;
}

interface Exchange {
  readonly request: IncomingMessage;
  readonly url: URL;
  readonly body: unknown;
}

type Reply = readonly [number, unknown];

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text === "" ? null : JSON.parse(text);
}

function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null
    ? Reflect.get(body, name)
    : undefined;
}

function pairingView(pairing: FakePairing): Readonly<Record<string, unknown>> {
  return {
    pairing_id: pairing.pairingId,
    stage: pairing.stage,
    expires_at: pairing.expiresAt,
    request: pairing.request,
    check: pairing.check,
  };
}

function changed(state: FakeState): void {
  for (const wake of state.waiting) wake();
}

function daemonOf(
  state: FakeState,
  request: IncomingMessage,
): FakeDaemon | undefined {
  const token = request.headers.authorization?.replace(/^Bearer /, "");
  if (token === undefined || state.revoked.has(token)) return undefined;
  return state.daemons.find((daemon) => daemon.token === token);
}

function wakeUp(state: FakeState, deadline: number): Promise<void> {
  return new Promise((settle) => {
    const wake = (): void => {
      clearTimeout(timer);
      state.waiting.delete(wake);
      settle();
    };
    const timer = setTimeout(wake, deadline - Date.now());
    state.waiting.add(wake);
  });
}

async function longPoll(
  state: FakeState,
  exchange: { readonly pairing: FakePairing; readonly url: URL },
): Promise<Reply> {
  const { pairing, url } = exchange;
  const seconds = Number(url.searchParams.get("wait") ?? "0");
  const stage = url.searchParams.get("stage");
  const deadline = Date.now() + Math.min(seconds, 5) * 1000;
  while (pairing.stage === stage && Date.now() < deadline)
    await wakeUp(state, deadline);
  return [200, pairingView(pairing)];
}

function registered(state: FakeState, body: unknown): Reply {
  const number = String(state.daemons.length + 1);
  const daemon: FakeDaemon = {
    daemonId: `dmn_test${number}`,
    token: `token-${number}`,
    name: field(body, "name"),
    agreementPublicKey: field(body, "agreement_public_key"),
    signingPublicKey: field(body, "signing_public_key"),
  };
  state.daemons.push(daemon);
  return [201, { daemon_id: daemon.daemonId, token: daemon.token }];
}

function opened(
  state: FakeState,
  exchange: { readonly daemon: FakeDaemon; readonly body: unknown },
): Reply {
  const lifetime = state.settings.pairingMilliseconds ?? 600_000;
  const pairing: FakePairing = {
    pairingId: String(field(exchange.body, "pairing_id")),
    daemonId: exchange.daemon.daemonId,
    stage: "open",
    expiresAt: new Date(Date.now() + lifetime).toISOString(),
    request: null,
    receipt: null,
    check: null,
  };
  state.pairings.set(pairing.pairingId, pairing);
  return [201, pairingView(pairing)];
}

function acted(
  state: FakeState,
  exchange: {
    readonly pairing: FakePairing;
    readonly action: string;
    readonly body: unknown;
  },
): Reply {
  const { pairing, action, body } = exchange;
  if (action === "deny") pairing.stage = "denied";
  if (action === "receipt" && state.settings.receiptStatus !== undefined)
    return [state.settings.receiptStatus, null];
  if (action === "receipt") {
    pairing.stage = "completed";
    pairing.receipt = field(body, "receipt");
  }
  changed(state);
  return action === "deny" || action === "receipt"
    ? [200, pairingView(pairing)]
    : [404, null];
}

function removed(
  state: FakeState,
  exchange: { readonly daemon: FakeDaemon; readonly path: string },
): Reply {
  if (exchange.path === "/api/v1/relay/daemon") {
    state.revoked.add(exchange.daemon.token);
    return [204, null];
  }
  return exchange.path.startsWith("/api/v1/relay/devices/")
    ? [204, null]
    : [404, null];
}

function pairingRoute(
  state: FakeState,
  exchange: Exchange & { readonly daemon: FakeDaemon },
): Promise<Reply> | Reply {
  const { request, url, body, daemon } = exchange;
  const [, pairingId = "", action] =
    /^\/api\/v1\/relay\/pairings\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname) ??
    [];
  const pairing = state.pairings.get(pairingId);
  if (pairing?.daemonId !== daemon.daemonId) return [404, null];
  if (request.method === "GET" && action === undefined)
    return longPoll(state, { pairing, url });
  return acted(state, { pairing, action: String(action), body });
}

async function routed(state: FakeState, exchange: Exchange): Promise<Reply> {
  const { request, url, body } = exchange;
  const path = url.pathname;
  if (request.method === "POST" && path === "/api/v1/relay/daemons") {
    await new Promise((settle) =>
      setTimeout(settle, state.settings.registerDelayMilliseconds ?? 0),
    );
    return registered(state, body);
  }
  const daemon = daemonOf(state, request);
  if (daemon === undefined) return [401, null];
  if (request.method === "POST" && path === "/api/v1/relay/pairings") {
    await new Promise((settle) =>
      setTimeout(settle, state.settings.startDelayMilliseconds ?? 0),
    );
    return opened(state, { daemon, body });
  }
  if (request.method === "DELETE") return removed(state, { daemon, path });
  return pairingRoute(state, { ...exchange, daemon });
}

async function answered(
  state: FakeState,
  exchange: {
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
  },
): Promise<void> {
  const { request, response } = exchange;
  const url = new URL(String(request.url), "http://127.0.0.1");
  const body = await bodyOf(request);
  state.requests.push({
    method: String(request.method),
    path: `${url.pathname}${url.search}`,
    authorization: request.headers.authorization,
    body,
  });
  const [status, reply] = await routed(state, { request, url, body });
  response.writeHead(status, { "content-type": "application/json" });
  response.end(reply === null ? "" : JSON.stringify(reply));
}

export async function fakeRelayServer(
  settings: Settings = {},
): Promise<FakeRelayServer> {
  const state: FakeState = {
    settings,
    requests: [],
    daemons: [],
    pairings: new Map(),
    revoked: new Set(),
    waiting: new Set(),
  };
  const server = createServer((request, response) => {
    answered(state, { request, response }).catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((ready) => {
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests: state.requests,
    daemons: state.daemons,
    pairings: state.pairings,
    revoke: (token) => {
      state.revoked.add(token);
    },
    change: (pairingId, update) => {
      const pairing = state.pairings.get(pairingId);
      if (pairing !== undefined) Object.assign(pairing, update);
      changed(state);
    },
    close: async () => {
      changed(state);
      server.closeAllConnections();
      await new Promise((settle) => server.close(settle));
    },
  };
}
