import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openAuthority } from "../src/broker/actor/authority.ts";
import { scaleDatabase } from "./authority-opening-fixture.ts";
import {
  removeTemporaryDirectories,
  temporaryDirectory,
} from "./authority-store-fixture.ts";

await test("CLV-048 opens 1000, 10000 and 50000 events within two seconds with bounded growth", async () => {
  const milliseconds = new Map<number, number>();
  for (const count of [1_000, 10_000, 50_000]) {
    const directory = await temporaryDirectory();
    await scaleDatabase(directory, count);
    const started = performance.now();
    const opening = await openAuthority(directory);
    const elapsed = performance.now() - started;
    milliseconds.set(count, elapsed);
    process.stdout.write(
      JSON.stringify({ events: count, milliseconds: elapsed }) + "\n",
    );
    assert.equal(opening.kind, "opened", JSON.stringify(opening));
    await opening.authority.close();
    assert.ok(elapsed < 2_000, `opening took ${String(elapsed)} ms`);
  }
  const smaller = milliseconds.get(10_000);
  const larger = milliseconds.get(50_000);
  assert.ok(smaller);
  assert.ok(larger);
  assert.ok(larger < smaller * 8, `growth was ${String(larger / smaller)}`);
});

after(removeTemporaryDirectories);
