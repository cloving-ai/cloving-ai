import assert from "node:assert/strict";
import { test } from "node:test";
import { brokerAuthorization } from "../src/broker/actor/authority-policy.ts";

const broker = {};
const policy = brokerAuthorization(broker);

function message(operation: string, authorizationContext: unknown): boolean {
  return policy.authorizeMessage({
    actorType: "ClovingAuthority",
    actorId: "authority",
    operation,
    arguments: {},
    authorizationContext,
  });
}

await test("CLV-042 only the opening broker may send authority commands, and nobody may send delivery callbacks from outside", () => {
  assert.deepEqual(
    [
      "adopt",
      "beginEpoch",
      "execute",
      "deliveryCompleted",
      "deliveryFailed",
    ].map((operation) => [
      message(operation, broker),
      message(operation, {}),
      message(operation, undefined),
    ]),
    [
      [true, false, false],
      [true, false, false],
      [true, false, false],
      [false, false, false],
      [false, false, false],
    ],
  );
});

await test("CLV-042 queries and destruction are denied, and administration and a subscription need the broker", () => {
  const actor = {
    actorType: "ClovingAuthority",
    actorId: "authority",
    authorizationContext: broker,
  };
  assert.equal(
    policy.authorizeQuery({ ...actor, operation: "execute", arguments: {} }),
    false,
  );
  assert.equal(policy.authorizeDestroy(actor), false);
  assert.deepEqual(
    [broker, {}, undefined].map((authorizationContext) =>
      policy.authorizeSubscription({ ...actor, authorizationContext }),
    ),
    [true, false, false],
  );
  assert.deepEqual(
    [broker, {}].map((authorizationContext) =>
      policy.authorizeAdministration({
        action: "inspect",
        resource: "processes",
        authorizationContext,
      }),
    ),
    [true, false],
  );
});
