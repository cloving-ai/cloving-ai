import assert from "node:assert/strict";
import { test } from "node:test";
import { component } from "../src/cli/watch-element.ts";
import { Demo } from "../src/cli/watch-shelf-view.ts";
import { found } from "./watch-dom.ts";
import { demoUrl, shelfModel } from "./watch-shelf-fixture.ts";

function player(): Readonly<Record<string, unknown>> {
  const [tile] = shelfModel().completed ?? [];
  assert.ok(tile !== undefined);
  const shown = component(Demo, { tile, demo: demoUrl });
  const box = found(shown, "div").find(
    (props) => props["class"] === "demo-player",
  );
  assert.ok(box !== undefined);
  return box;
}

await test("CLV-288 CLV-292 the demo player plays its video when it opens, pauses it when it closes, and keeps a refused play quiet", async () => {
  const calls: string[] = [];
  const video = {
    play: () => {
      calls.push("play");
      return Promise.reject(new Error("autoplay-refused"));
    },
    pause: () => {
      calls.push("pause");
    },
  };
  const toggled = player()["onToggle"];
  assert.ok(typeof toggled === "function");
  for (const newState of ["open", "closed"])
    Reflect.apply(toggled, undefined, [
      { newState, currentTarget: { firstChild: video } },
    ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["play", "pause"]);
});
