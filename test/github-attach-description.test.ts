import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { methods } from "../src/daemon/github-methods.ts";
import {
  fakeGh,
  operation,
  payload,
  playerUrl,
  video,
  withScene,
  type GithubState,
} from "./github-attach-fixture.ts";

const attach = methods.get("attach-asset");
const start = "<!-- cloving-attachment:12:demo.mp4 -->";
const end = "<!-- /cloving-attachment:12:demo.mp4 -->";
const description = { ...payload, place: "description" };

await test("CLV-282 the description place attaches the file with gh and writes the marked block into the body", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const state: GithubState = {
      releases: [],
      comments: [],
      pullBody: "Refs #3\n\nThe change.",
    };
    const result = await attach(
      operation(scene, { payload: description, gh: fakeGh(scene, state) }),
    );
    assert.deepEqual(result, { number: 12, url: playerUrl });
    assert.equal(
      state.pullBody,
      `Refs #3\n\nThe change.\n\n${start}\nDemo of the change.\n\n${playerUrl}\n${end}`,
    );
    assert.ok(state.attached?.equals(video));
    const edit = scene.calls.find((parts) => parts[0] === "pr");
    assert.deepEqual(edit?.slice(0, 3), ["pr", "edit", "12"]);
    assert.equal(
      scene.calls.some(
        (parts) =>
          parts[0] === "release" ||
          parts.some((part) => part.includes("/comments")),
      ),
      false,
    );
    assert.deepEqual(readdirSync(join(scene.root, "operation")), []);
  }));

await test("CLV-282 a second description attach replaces its block", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const state: GithubState = {
      releases: [],
      comments: [],
      pullBody: `Refs #3\n\n${start}\nOld.\n${end}\n\nAfter.`,
    };
    await attach(
      operation(scene, { payload: description, gh: fakeGh(scene, state) }),
    );
    assert.equal(
      state.pullBody,
      `Refs #3\n\n${start}\nDemo of the change.\n\n${playerUrl}\n${end}\n\nAfter.`,
    );
  }));

await test("CLV-282 an unknown place is refused before any GitHub call", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    await assert.rejects(
      attach(
        operation(scene, {
          payload: { ...payload, place: "sidebar" },
          gh: fakeGh(scene, { releases: [], comments: [] }),
        }),
      ),
      /invalid-payload/,
    );
    assert.deepEqual(scene.calls, []);
  }));

await test("CLV-282 a body that keeps the local reference after the edit fails", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const state: GithubState = {
      releases: [],
      comments: [],
      pullBody: "Refs #3",
      rewrite: "none",
    };
    await assert.rejects(
      attach(
        operation(scene, { payload: description, gh: fakeGh(scene, state) }),
      ),
      /github-call-failed/,
    );
  }));

await test("CLV-282 an attachment link in the text does not replace the new player URL", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    const state: GithubState = { releases: [], comments: [], pullBody: "" };
    const result = await attach(
      operation(scene, {
        payload: {
          ...description,
          comment:
            "Demo of the change. Before: https://github.com/user-attachments/assets/old-demo",
        },
        gh: fakeGh(scene, state),
      }),
    );
    assert.deepEqual(result, { number: 12, url: playerUrl });
  }));

await test("CLV-282 two description attaches on one pull request keep both blocks", () =>
  withScene(async (scene) => {
    assert.ok(attach);
    await writeFile(join(scene.attachments, "other.mp4"), video);
    const state: GithubState = { releases: [], comments: [], pullBody: "" };
    const gh = fakeGh(scene, state);
    await Promise.all([
      attach(operation(scene, { payload: description, gh })),
      attach(
        operation(scene, {
          payload: { ...description, name: "other.mp4" },
          gh,
        }),
      ),
    ]);
    assert.ok(state.pullBody?.includes(start));
    assert.ok(
      state.pullBody?.includes("<!-- cloving-attachment:12:other.mp4 -->"),
    );
  }));
