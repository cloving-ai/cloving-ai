import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { analysisCommand } from "../src/daemon/analysis-launch.ts";
import { parseCorpus } from "../src/chats/corpus-input.ts";
import { field } from "./develop-workflow-fixture.ts";
import { withConsumer, productRoot } from "./world-host-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import { analysisSource } from "./analyze-chats-sdk-fixture.ts";
import { batchCorpus, batchSetup } from "./analyze-chats-batches-fixture.ts";
import { batch, questionBatch } from "./chats-analysis-merge-fixture.ts";

const privateText =
  "BATCH-PRIVATE ../../parent /leading //network \\leading ~/notes /home/synthetic/notes C:\\Users\\synthetic\\notes user@example.invalid <mail@example.invalid> mailto:link@example.invalid @operator @team /a.*b/g";
const plain = {
  ...batch(),
  process: { ...batch().process, name: privateText },
};
const question = {
  ...questionBatch(),
  process: { ...questionBatch().process, name: privateText },
};
question.openQuestion.description = privateText;
question.openQuestion.choices[0] = {
  id: privateText,
  description: privateText,
};
const corpus = parseCorpus(batchCorpus(2_300))
  .map((message) =>
    JSON.stringify({ ...message, text: privateText + message.text }),
  )
  .join("\n");
const watchUrl = JSON.stringify(
  pathToFileURL(join(productRoot, "test/watch-fixture.ts")).href,
);

await test(
  "CLV-160 batched question evidence context draft and answer stay inert and private through restricted fake launches",
  chatPlatformScenario(() =>
    withConsumer(analysisSource, async (consumer) => {
      const result =
        await consumer.run(`${batchSetup({ corpus, reply: [plain, question, plain, plain], mode: "planned-replies" })}
const { watchedModel } = await import(${watchUrl});
const runId = await submitAnalysis();
await until(async () => ["waiting_gate", "completed"].includes(await stateOf(runId)));
const [question] = (await asked("questions", { runId })).decisions;
if (!question) throw new Error("analysis-question-not-opened");
const pending = await watchedModel(runtimeDirectory);
const prompt = JSON.parse(question.prompt);
const choice = prompt.question.choices[0].id;
await asked("decision", { command: "answer", reference: question.decisionId, text: choice, expectedRevision: question.revision, generation: question.generation, subjectDigest: question.subjectDigest, commandId: "private-answer" });
await until(async () => (await stateOf(runId)) === "completed" && (await tagged()).every((run) => run.status === "completed"));
const final = await watchedModel(runtimeDirectory);
const status = await asked("status", { runId });
const events = await asked("events", { runId, after: 0, limit: 1000 });
const turns = lines("turns.log").map((line) => JSON.parse(line));
const payloads = turns.map((turn) => JSON.parse(turn.prompt));
const journals = readdirSync("journal").flatMap((key) => readdirSync("journal/" + key).map((name) => ({ name, path: "journal/" + key + "/" + name })));
const metadata = journals.filter(({ name }) => name !== "result.json").map(({ path }) => readFileSync(path, "utf8")).join("");
const logs = ["requests.log", "analysis-effects.log", "analysis-continuations.log"].map((file) => lines(file).join("\\n")).join("");
const needle = ${JSON.stringify(privateText)};
print({ arguments: turns.map((turn) => turn.arguments), dataMatch: payloads[2]?.followUp?.answer === needle && payloads[2]?.followUp?.draft.openQuestion.description === needle && payloads[2]?.context.previousResult.process.name === needle && payloads[2]?.evidence.corpus.includes("BATCH-PRIVATE"), operationalSafe: !JSON.stringify({ pending, final, status, events }).includes("BATCH-PRIVATE"), logsSafe: !logs.includes("BATCH-PRIVATE") && !metadata.includes("BATCH-PRIVATE"), noRawLogs: journals.every(({ name }) => !["turn.jsonl", "turn.stderr.log", "working", "configuration"].includes(name)), isolated: turns.every((turn) => turn.files.length === 0 && turn.environment.ANTHROPIC_API_KEY === undefined) });
await finished(runId);
`);
      assert.equal(
        result.status,
        0,
        result.stderr + JSON.stringify(result.lines),
      );
      assert.equal(result.stderr.includes("BATCH-PRIVATE"), false);
      for (const key of [
        "dataMatch",
        "operationalSafe",
        "logsSafe",
        "noRawLogs",
        "isolated",
      ])
        assert.equal(field(result.lines[0], key), true, key);
      assert.deepEqual(
        field(result.lines[0], "arguments"),
        Array.from({ length: 4 }, () => analysisCommand().slice(1)),
      );
      assert.equal(
        field(field(result.lines[1], "outcome"), "kind"),
        "handoff_requested",
      );
      assert.deepEqual(field(result.lines[1], "budget"), {
        limit: 11,
        spent: 9,
      });
    }),
  ),
);
