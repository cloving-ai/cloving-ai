export * from "./analysis-contract.ts";
import {
  analysisCodes,
  type AnalysisCode,
  type AnalysisEvidence,
  type AnalysisValidation,
} from "./analysis-contract.ts";
import { inspectAnalysisShape } from "./analysis-shape.ts";
import { inspectAnalysisLinks } from "./analysis-links.ts";
import { inspectAnalysisData } from "./analysis-data.ts";
import {
  matchingAnalysisEvidence,
  inspectAnalysisSupport,
  inspectAnalysisQuestion,
} from "./analysis-provenance.ts";

export function validateAnalysis(
  candidate: unknown,
  evidence: AnalysisEvidence,
): AnalysisValidation {
  const codes = new Set<AnalysisCode>(inspectAnalysisData(candidate));
  if (codes.has("not-plain-data"))
    return { accepted: false, codes: ["not-plain-data"] };
  if (!inspectAnalysisShape(candidate, codes))
    return {
      accepted: false,
      codes: analysisCodes.filter((code) => codes.has(code)),
    };
  for (const code of inspectAnalysisLinks(candidate.process)) codes.add(code);
  if (matchingAnalysisEvidence(evidence)) {
    for (const code of inspectAnalysisSupport(candidate.process, evidence))
      codes.add(code);
    for (const code of inspectAnalysisQuestion(candidate, evidence))
      codes.add(code);
  } else codes.add("invalid-shape");
  if (codes.size > 0)
    return {
      accepted: false,
      codes: analysisCodes.filter((code) => codes.has(code)),
    };
  return {
    accepted: true,
    result: {
      ...candidate,
      limitations: {
        historyCompleteness: "unknown",
        independentObservations: "not-established",
        conflictGroups: evidence.structure.conflictGroups,
      },
    },
  };
}
