type StringRecord = Readonly<Record<string, string>>;
type TriggerFilter = Readonly<Record<string, readonly string[]>>;
export type Command = readonly string[];

export interface WorkflowStep {
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly "continue-on-error"?: boolean;
  readonly with?: Readonly<Record<string, string | boolean>>;
  readonly env?: StringRecord;
}

interface WorkflowStrategy {
  readonly "fail-fast": boolean;
  readonly matrix: Readonly<Record<string, readonly string[]>>;
}

export interface WorkflowJob {
  readonly "runs-on": string;
  readonly "timeout-minutes": number;
  readonly steps: readonly WorkflowStep[];
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly permissions?: StringRecord;
  readonly env?: StringRecord;
  readonly strategy?: WorkflowStrategy;
}

export interface ReleaseWorkflow {
  readonly on: Readonly<Record<string, TriggerFilter>>;
  readonly permissions: StringRecord;
  readonly concurrency?: Readonly<Record<string, string | boolean>>;
  readonly jobs: {
    readonly quality: WorkflowJob;
    readonly quality_macos: WorkflowJob;
    readonly coverage: WorkflowJob;
    readonly quality_linux: WorkflowJob;
    readonly quality_linux_node: WorkflowJob;
    readonly publish: WorkflowJob;
  };
}

export interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly bin: StringRecord;
  readonly engines: StringRecord;
  readonly os: readonly string[];
  readonly cpu: readonly string[];
  readonly dependencies: StringRecord;
  readonly devDependencies: StringRecord;
  readonly private?: boolean;
  readonly repository?: StringRecord;
  readonly homepage?: string;
  readonly bugs?: StringRecord;
}

export interface PackageLock {
  readonly version: string;
  readonly packages: { readonly "": PackageMetadata };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecordOf<Value>(
  value: unknown,
  valid: (entry: unknown) => entry is Value,
): value is Readonly<Record<string, Value>> {
  return isRecord(value) && Object.values(value).every(valid);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringRecord(value: unknown): value is StringRecord {
  return isRecordOf(value, isString);
}

function isInput(value: unknown): value is string | boolean {
  return typeof value === "string" || typeof value === "boolean";
}

function isCommand(value: unknown): value is Command {
  return Array.isArray(value) && value.every(isString);
}

function isTriggerFilter(value: unknown): value is TriggerFilter {
  return isRecordOf(value, isCommand);
}

function isStep(value: unknown): value is WorkflowStep {
  if (!isRecord(value)) return false;
  return (
    ["id", "uses", "run", "if"].every(
      (name) => value[name] === undefined || isString(value[name]),
    ) &&
    (value["continue-on-error"] === undefined ||
      typeof value["continue-on-error"] === "boolean") &&
    (value["with"] === undefined || isRecordOf(value["with"], isInput)) &&
    (value["env"] === undefined || isStringRecord(value["env"]))
  );
}

function isStrategy(value: unknown): value is WorkflowStrategy {
  return (
    isRecord(value) &&
    typeof value["fail-fast"] === "boolean" &&
    isRecordOf(value["matrix"], isCommand)
  );
}

function validNeeds(value: unknown): boolean {
  return value === undefined || isString(value) || isCommand(value);
}

function optional(value: unknown, valid: (entry: unknown) => boolean): boolean {
  return value === undefined || valid(value);
}

function isJob(value: unknown): value is WorkflowJob {
  if (!isRecord(value)) return false;
  return (
    isString(value["runs-on"]) &&
    typeof value["timeout-minutes"] === "number" &&
    Array.isArray(value["steps"]) &&
    value["steps"].every(isStep) &&
    optional(value["if"], isString) &&
    validNeeds(value["needs"]) &&
    optional(value["strategy"], isStrategy) &&
    ["permissions", "env"].every((name) =>
      optional(value[name], isStringRecord),
    )
  );
}

export function isWorkflow(value: unknown): value is ReleaseWorkflow {
  if (!isRecord(value)) return false;
  const jobs = value["jobs"];
  return (
    isRecordOf(value["on"], isTriggerFilter) &&
    isStringRecord(value["permissions"]) &&
    isRecordOf(jobs, isJob) &&
    [
      "quality",
      "quality_macos",
      "coverage",
      "quality_linux",
      "quality_linux_node",
      "publish",
    ].every((name) => name in jobs)
  );
}

export function isPackageMetadata(value: unknown): value is PackageMetadata {
  if (!isRecord(value)) return false;
  return (
    ["name", "version", "license"].every((name) => isString(value[name])) &&
    ["bin", "engines", "dependencies", "devDependencies"].every((name) =>
      isStringRecord(value[name]),
    ) &&
    isCommand(value["os"]) &&
    isCommand(value["cpu"]) &&
    (value["private"] === undefined || typeof value["private"] === "boolean") &&
    (value["homepage"] === undefined || isString(value["homepage"])) &&
    ["repository", "bugs"].every(
      (name) => value[name] === undefined || isStringRecord(value[name]),
    )
  );
}

export function isPackageLock(value: unknown): value is PackageLock {
  if (!isRecord(value)) return false;
  const packages = value["packages"];
  return (
    isString(value["version"]) &&
    isRecord(packages) &&
    isPackageMetadata(packages[""])
  );
}
