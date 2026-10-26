import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { record } from "../src/protocol.ts";
import { relayRequest } from "../src/relay/relay-http.ts";

export async function registeredLink(
  server: { readonly origin: string },
  phoneDirectory: string,
): Promise<void> {
  const reply = await relayRequest(server.origin, {
    method: "POST",
    path: "/api/v1/relay/daemons",
    body: {},
  });
  await mkdir(phoneDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(phoneDirectory, "link.json"),
    JSON.stringify({
      daemonId: record(reply.body)?.["daemon_id"],
      origin: server.origin,
      token: record(reply.body)?.["token"],
      registeredAt: "2026-10-25T12:00:00Z",
    }),
    { mode: 0o600 },
  );
}
