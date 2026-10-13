import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArchitecture } from "../../quality/architecture.ts";
import { checkedTree } from "./sender-fixture.ts";

const address = '"https://example.invalid"';

async function checked(
  module: { readonly file: string; readonly role: string },
  source: string,
): Promise<string> {
  return await checkedTree(
    { [module.file]: { role: module.role, source } },
    (program, policy) => {
      try {
        checkArchitecture(program, policy);
        return "accepted";
      } catch (error) {
        return String(error);
      }
    },
  );
}

await test("CLV-054 the protected check rejects a network global in a broker, storage, service or step module, and accepts it in a module of the command line tool", async () => {
  const broker = { file: "src/broker/sender.ts", role: "broker" };
  for (const body of [
    `return fetch(${address});`,
    `return new WebSocket(${address});`,
    `return new EventSource(${address});`,
    "return new XMLHttpRequest();",
    `return globalThis.fetch(${address});`,
    `return globalThis["fetch"](${address});`,
    `const { fetch: send } = globalThis; return send(${address});`,
    `const { fetch } = globalThis; return fetch(${address});`,
    "return { fetch };",
    "const send = fetch; return send;",
  ])
    assert.match(
      await checked(broker, `export function send(): unknown { ${body} }`),
      /network-global:[^]*src\/broker\/sender\.ts/,
      body,
    );
  for (const module of [
    { file: "src/storage/sender.ts", role: "storage" },
    { file: "src/service/sender.ts", role: "service" },
    { file: "src/steps/sender.ts", role: "step" },
  ])
    assert.match(
      await checked(
        module,
        `export function send(): unknown { return fetch(${address}); }`,
      ),
      /network-global:/,
      module.role,
    );
  assert.equal(
    await checked(
      { file: "src/cli/sender.ts", role: "cli" },
      `export function send(): unknown { return fetch(${address}); }`,
    ),
    "accepted",
  );
  assert.equal(
    await checked(
      broker,
      'interface Cache { fetch(key: string): string } function fetch(key: string): string { return key; } export function read(cache: Cache): unknown { return [fetch("key"), cache.fetch("key"), { fetch: 1 }, Date.now(), setTimeout(() => undefined, 1)]; } export type Sender = typeof globalThis.fetch; export type Socket = WebSocket;',
    ),
    "accepted",
  );
});
