export interface Observation {
  readonly condition: string;
  readonly reason: string;
  readonly evidence: string | null;
  readonly retryAt: string | null;
  readonly operationId: string | null;
  readonly attempt: number | null;
  readonly limit: number | null;
  readonly sequence: number;
  readonly recordedAt: string;
}

export interface RunDetails {
  readonly runId: string;
  readonly generation: number;
  readonly submission: string | null;
  readonly input: string | null;
  readonly resolver: string | null;
  readonly observation: Observation | null;
}

type Payload = Readonly<Record<string, string>>;

export function admittedDetails(runId: string, payload: Payload): RunDetails {
  return {
    runId,
    generation: 1,
    submission: payload["submission"] ?? null,
    input: payload["input"] ?? null,
    resolver: payload["resolver"] ?? null,
    observation: null,
  };
}

function count(value: string | undefined): number | null {
  return value === undefined ? null : Number(value);
}

export function observed(
  details: RunDetails,
  event: {
    readonly payload: Payload;
    readonly sequence: number;
    readonly recordedAt: string;
  },
): RunDetails {
  const { payload } = event;
  return {
    ...details,
    observation: {
      condition: payload["condition"] ?? "",
      reason: payload["reason"] ?? "",
      evidence: payload["evidence"] ?? null,
      retryAt: payload["retryAt"] ?? null,
      operationId: payload["operationId"] ?? null,
      attempt: count(payload["attempt"]),
      limit: count(payload["limit"]),
      sequence: event.sequence,
      recordedAt: event.recordedAt,
    },
  };
}

export function continued(details: RunDetails): RunDetails {
  return { ...details, generation: details.generation + 1 };
}
