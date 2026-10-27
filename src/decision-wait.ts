export function decisionToken(runId: string, gateId: string): string {
  return `cloving-decision/v1/${encodeURIComponent(runId)}/${encodeURIComponent(gateId)}`;
}
