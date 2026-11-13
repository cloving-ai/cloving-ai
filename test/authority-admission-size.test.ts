import assert from "node:assert/strict";
import { test } from "node:test";
import { json, oversized } from "../src/broker/actor/authority-receipts.ts";
import { documentDigest } from "../src/broker/decision-restore.ts";

await test("CLV-362 only a validated feed submission discounts double JSON escaping", () => {
  const ticket = { id: "765", text: "\u0000".repeat(65_536) };
  const body = JSON.stringify({
    workflowId: "develop",
    source: "feed",
    submission: { ticket },
  });
  const digest = documentDigest(body);
  const documents = [
    { digest, body },
    { body: JSON.stringify({ input: { ticket } }) },
  ];
  const command = { kind: "admit-run", submission: digest };
  assert.ok(Buffer.byteLength(JSON.stringify(documents)) > 900_000);
  assert.equal(oversized(json({ command, documents })), false);
  assert.equal(
    oversized(
      json({ command: { ...command, kind: "report-observation" }, documents }),
    ),
    true,
  );
  assert.equal(
    oversized(
      json({ command: { ...command, submission: "other" }, documents }),
    ),
    true,
  );
  assert.equal(
    oversized(json({ command, documents: [{ body: '"'.repeat(520_000) }] })),
    true,
  );
  assert.equal(
    oversized(
      json({
        command,
        documents: [
          {
            digest,
            body: JSON.stringify({
              source: "feed",
              submission: { ticket: { ...ticket, id: "bad id" } },
            }),
          },
          documents[1],
        ],
      }),
    ),
    true,
  );
  assert.equal(
    oversized(
      json({ command, documents: [{ digest, body: '"'.repeat(520_000) }] }),
    ),
    true,
  );
});
