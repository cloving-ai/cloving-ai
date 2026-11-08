export interface ReleaseInput {
  readonly cycleId: string;
  readonly repository: string;
  readonly input: {
    readonly version: string;
    readonly pullRequests?: string;
  };
}

export interface ReleaseTask {
  readonly cycleId: string;
  readonly repository: string;
  readonly version: string;
  readonly tag: string;
  readonly pullRequests: readonly number[];
}

const versionPattern =
  /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function invalid(): never {
  throw new Error("invalid-release-input");
}

function pullNumbers(text: string | undefined): readonly number[] {
  if (text === undefined) return [];
  const items = text.split(/[\s,]+/).filter((item) => item !== "");
  if (items.length === 0 || items.length > 50) invalid();
  const numbers = items.map((item) =>
    /^#?[1-9]\d{0,9}$/.test(item) ? Number(item.replace("#", "")) : invalid(),
  );
  if (new Set(numbers).size !== numbers.length) invalid();
  return numbers;
}

export function releaseTask(request: ReleaseInput): ReleaseTask {
  const { version, pullRequests } = request.input;
  if (typeof version !== "string" || !versionPattern.test(version)) invalid();
  return {
    cycleId: request.cycleId,
    repository: request.repository,
    version,
    tag: `v${version}`,
    pullRequests: pullNumbers(pullRequests),
  };
}
