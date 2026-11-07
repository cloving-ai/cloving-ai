import assert from "node:assert/strict";
import {
  fakeStepBridge,
  type ScenarioRequest,
} from "cloving/workflows/testing";
import { develop } from "../develop.ts";
import { approved, requestInput, scenarioEffects } from "./option-tests.ts";
import { lessonsPayload, lessonsTask } from "./lessons.ts";
import { preparePull } from "./pull.ts";
import { developReport, ticketInput } from "./report.ts";
import { completed, input, selection } from "./scenarios.ts";
import { developTurn } from "./turn.ts";

const lessonsText =
  "- 2026-11-05 CLV-296: Do not assert exact timer values in tests.\n";

async function turnPayload(lessons: {
  readonly text: string;
  readonly bytes: number;
}): Promise<string> {
  using bridge = fakeStepBridge({});
  await developTurn({
    cycleId: "run-1",
    repository: "main-checkout",
    ticket: "# CLV-303: Fix the counter",
    round: 1,
    feedback: null,
    lessons,
  });
  const request = bridge.requests[0];
  assert.ok(request && request[0] === "effect");
  return request[1].payload;
}

const interrupted = {
  kind: "failed" as const,
  operationId: "interrupted-turn",
  reason: "claude-turn-interrupted",
};

function prepared() {
  return completed({
    branch: "cloving/run-1",
    lessons: { text: lessonsText, bytes: lessonsText.length },
  });
}

function effectsOf(requests: readonly ScenarioRequest[], method: string) {
  return requests.flatMap((request) =>
    request[0] === "effect" && request[1].method === method ? [request[1]] : [],
  );
}

export const lessonsTests = [
  {
    name: "CLV-303 the selected lessons option reads the file once into each turn",
    run: async () => {
      const scenario = scenarioEffects();
      using bridge = fakeStepBridge({
        effects: {
          ...scenario,
          "github prepare": [prepared()],
          "claude run-turn": [interrupted, ...scenario["claude run-turn"]],
        },
        decisions: [approved, approved],
      });
      assert.equal((await develop(requestInput())).kind, "handoff_requested");
      const file = selection.lessons === "file";
      const prepare = effectsOf(bridge.requests, "prepare");
      assert.deepEqual(
        prepare.map((request) => request.payload),
        selection.merge === "local" ? [] : [file ? '{"lessons":true}' : "{}"],
      );
      const turns = effectsOf(bridge.requests, "run-turn").filter(
        (request) => request.scope.phase === "implement",
      );
      assert.equal(turns.length, 2);
      for (const turn of turns) {
        assert.equal(turn.payload.includes(lessonsText), file);
        assert.equal(turn.payload.includes(".cloving/lessons.md"), file);
      }
    },
  },
  {
    name: "CLV-303 a fix turn keeps the lessons that the run read",
    run: async () => {
      using bridge = fakeStepBridge({
        effects: {
          "github prepare": [prepared()],
          "claude run-turn": [
            completed({ summary: "Fixed.\nTicket status: complete" }),
          ],
        },
      });
      const task = await preparePull(ticketInput(input));
      const report = await developReport({
        input: task,
        round: 2,
        feedback: { reason: "check-failed", output: "Out.\n", remaining: [] },
      });
      assert.ok(!("kind" in report));
      const [turn] = effectsOf(bridge.requests, "run-turn");
      assert.ok(turn);
      assert.match(turn.payload, /This is fix round 2/);
      assert.equal(
        turn.payload.includes(lessonsText),
        selection.lessons === "file",
      );
    },
  },
  {
    name: "CLV-303 the turn prompt includes the text of the lessons file",
    run: async () => {
      const payload = await turnPayload({
        text: lessonsText,
        bytes: lessonsText.length,
      });
      assert.ok(payload.includes(lessonsText), payload);
      assert.match(payload, /\.cloving\/lessons\.md/);
    },
  },
  {
    name: "CLV-303 the turn prompt tells how to add up to three new lessons",
    run: async () => {
      const payload = await turnPayload({
        text: lessonsText,
        bytes: lessonsText.length,
      });
      for (const rule of [
        /up to three new lessons/,
        /one line/,
        /ASD-STE100 Simplified Technical English/,
        /- YYYY-MM-DD TICKET: /,
        /already has in the same or a similar form/,
        /same commit as the other changes/,
      ])
        assert.match(payload, rule);
    },
  },
  {
    name: "CLV-303 the turn prompt tells how to shorten a file over 16 KB",
    run: async () => {
      const small = await turnPayload({
        text: lessonsText,
        bytes: lessonsText.length,
      });
      const large = await turnPayload({
        text: lessonsText,
        bytes: 20000,
      });
      const shorten =
        /join similar lessons and remove lessons that no longer apply, until the file is smaller than 16384 bytes/;
      assert.match(small, shorten);
      assert.match(large, shorten);
      const over =
        /The file has 20000 bytes\. This is more than the limit of 16384 bytes\. The text below is the first 16384 bytes\./;
      assert.doesNotMatch(small, /more than the limit/);
      assert.match(large, over);
    },
  },
  {
    name: "CLV-303 an empty lessons file gives the add rules and no lesson text",
    run: async () => {
      const payload = await turnPayload({ text: "", bytes: 0 });
      assert.match(payload, /The file is empty\./);
      assert.match(payload, /up to three new lessons/);
    },
  },
  {
    name: "CLV-303 a turn without lessons does not name the lessons file",
    run: async () => {
      using bridge = fakeStepBridge({});
      for (const lessons of [null, undefined])
        await developTurn({
          cycleId: "run-1",
          repository: "main-checkout",
          ticket: "# CLV-303: Fix the counter",
          round: 1,
          feedback: null,
          ...(lessons === null ? { lessons } : {}),
        });
      assert.equal(bridge.requests.length, 2);
      for (const request of bridge.requests) {
        assert.ok(request[0] === "effect");
        assert.doesNotMatch(request[1].payload, /lessons/i);
      }
    },
  },
  {
    name: "CLV-303 the lessons helpers follow the selected mode",
    run: () => {
      const task = ticketInput(input);
      assert.equal(lessonsPayload("file"), '{"lessons":true}');
      assert.equal(lessonsPayload("none"), "{}");
      assert.equal(lessonsTask({ task, mode: "none", result: null }), task);
      assert.deepEqual(
        lessonsTask({ task, mode: "file", result: prepared().result }),
        {
          cycleId: task.cycleId,
          repository: task.repository,
          ticket: task.ticket,
          issue: task.issue,
          lessons: { text: lessonsText, bytes: lessonsText.length },
        },
      );
    },
  },
  {
    name: "CLV-303 an invalid lessons result fails before a turn",
    run: () => {
      const task = ticketInput(input);
      for (const result of [
        null,
        "null",
        "{}",
        '{"lessons":null}',
        '{"lessons":"text"}',
        '{"lessons":{"bytes":0}}',
        '{"lessons":{"text":1,"bytes":0}}',
        '{"lessons":{"text":""}}',
        '{"lessons":{"text":"","bytes":"0"}}',
        '{"lessons":{"text":"","bytes":-1}}',
        '{"lessons":{"text":"","bytes":1.5}}',
      ])
        assert.throws(() => lessonsTask({ task, mode: "file", result }), {
          message: "invalid-lessons",
        });
    },
  },
];
