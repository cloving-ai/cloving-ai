import type { AnalysisResult } from "./analysis-contract.ts";

const disclosureRules = [
  {
    code: "machine-path",
    pattern:
      /(?:^|[\s"'`=([{<,:;])(?:\/(?!\/)|\\|~(?:[a-z\d._-]+)?(?:[\\/]|$|(?=[\s"'`),;])))|(?:^|[\s"'`=([{<,;])\/\/|\b[a-z]:[a-z\d._\\/~-]|\bfile:|\$(?:\{(?:HOME|USERPROFILE|HOMEPATH|TMPDIR|APPDATA)\}|(?:env:)?(?:HOME|USERPROFILE|HOMEPATH|TMPDIR|APPDATA)\b)|%(?:HOME|USERPROFILE|HOMEPATH|TMPDIR|APPDATA)%/i,
  },
  {
    code: "parent-traversal",
    pattern:
      /(?:^|[\s"'`=([{<,:;\\/]|%2f|%5c)(?:\.|%2e){2}(?:[\\/]|%2f|%5c|$|(?=[\s"'`),;\]}]))/i,
  },
  {
    code: "email-form",
    pattern:
      /(?:[a-z\d.!#$%&'*+/=?^_`{|}~-]+|"[^"]+")@(?:[a-z\d.-]+|\[[^\]]+\])/i,
  },
  {
    code: "user-mention",
    pattern: /(?:^|[^a-z\d_.+-])@(?:[a-z\d_!&-]|\[)/i,
  },
  {
    code: "access-token-form",
    pattern:
      /(?:^|[^a-z\d])(?:gh[pousr]_|github_pat_|sk-(?:ant-|proj-|svcacct-)?|xox[baprs]-|npm_)[a-z\d_-]+|\b(?:AKIA|ASIA)[A-Z\d]{16}\b|\bBearer\s+\S+|\beyJ[a-z\d_-]*\.[a-z\d_-]+\.[a-z\d_-]+/i,
  },
  {
    code: "credential-form",
    pattern:
      /\b(?:[a-z\d_-]*(?:password|passwd|secret|token|credential|api[_-]?key|private[_-]?key)[a-z\d_-]*|api key|pwd|authorization)["']?\s*[:=]\s*\S+|\bBasic\s+[a-z\d+/]+=*|-----BEGIN (?:[A-Z\d]+ )*PRIVATE KEY(?: BLOCK)?-----|\b[a-z][a-z\d+.-]*:\/\/[^\s/?#<>]+@[^\s<>]+/i,
  },
] as const;

export type WorkflowGenerationTextCode =
  "text-length" | "text-characters" | (typeof disclosureRules)[number]["code"];

function renderableText(analysis: AnalysisResult): readonly string[] {
  const process = analysis.process;
  const items = [
    ...process.inputs,
    ...process.stages,
    ...process.branches,
    ...process.loops,
    ...process.artifacts,
    ...process.stoppingConditions,
    ...process.gates,
    ...process.nonGates,
  ];
  const texts = [
    process.id,
    process.name,
    process.scope,
    ...items.flatMap((item) => [item.id, item.description]),
    ...process.branches.flatMap((branch) => [
      branch.sourceStageId,
      branch.targetStageId,
      branch.condition,
    ]),
    ...process.loops.flatMap((loop) => [
      ...loop.stageIds,
      loop.exitCondition,
      loop.exhaustedStoppingConditionId,
    ]),
    ...process.gates.map((gate) => gate.stageId),
    ...process.nonGates.map((nonGate) => nonGate.stageId),
  ];
  const question = analysis.openQuestion;
  if (question)
    texts.push(
      question.claimId,
      question.description,
      ...question.choices.flatMap((choice) => [choice.id, choice.description]),
    );
  return texts;
}

export function inspectWorkflowGenerationText(
  analysis: AnalysisResult,
): readonly WorkflowGenerationTextCode[] {
  const texts = renderableText(analysis);
  const codes: WorkflowGenerationTextCode[] = [];
  if (texts.some((text) => text.length < 1 || text.length > 240))
    codes.push("text-length");
  if (texts.some((text) => /[^\x20-\x7e]/u.test(text)))
    codes.push("text-characters");
  const bounded = texts.filter((text) => text.length > 0 && text.length <= 240);
  for (const { code, pattern } of disclosureRules)
    if (bounded.some((text) => pattern.test(text))) codes.push(code);
  return codes;
}
