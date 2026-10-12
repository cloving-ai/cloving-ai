export interface AttemptSummary {
  readonly effectId: string;
  readonly purpose: string;
  readonly outcome: string | null;
  readonly stagedSequence: number;
}

export interface StopSubject {
  readonly operationId: string;
  readonly kind: string;
  readonly attempts: readonly AttemptSummary[];
  readonly status: string | null;
  readonly receipt: string | null;
  readonly stopped: boolean;
}

export type StopClass = "open" | "resolved" | "unknown" | "alive";

const finalStatuses = [
  "refused",
  "completed",
  "failed",
  "stopped",
  "cancelled",
];
const notStarted = ["withheld", "blocked", "absent"];

function sent(subject: StopSubject): boolean {
  return subject.attempts.some((attempt) => attempt.outcome === "sent");
}

function accepted(subject: StopSubject): boolean {
  return subject.receipt !== null || sent(subject);
}

function protectedClass(subject: StopSubject): StopClass {
  if (finalStatuses.includes(subject.status ?? "")) return "resolved";
  return subject.receipt === null ? "unknown" : "alive";
}

function runClass(subject: StopSubject): StopClass {
  if (subject.stopped) return "resolved";
  if (sent(subject)) return "alive";
  const last = subject.attempts.at(-1)?.outcome ?? "";
  return notStarted.includes(last) ? "resolved" : "unknown";
}

export function stopClasses(
  subjects: readonly StopSubject[],
): ReadonlyMap<string, StopClass> {
  return new Map(
    subjects.map((subject) => [subject.operationId, classOf(subject)]),
  );
}

function classOf(subject: StopSubject): StopClass {
  if (subject.attempts.some((attempt) => attempt.outcome === null))
    return "open";
  return subject.kind === "protected-effect"
    ? protectedClass(subject)
    : runClass(subject);
}

const stopPurposes = ["stop", "reconcile"];

export function stopCount(
  subject: StopSubject,
  cancelledSequence: number,
): number {
  return subject.attempts.filter(
    (attempt) =>
      attempt.outcome !== null &&
      stopPurposes.includes(attempt.purpose) &&
      attempt.stagedSequence >= cancelledSequence,
  ).length;
}

export interface StopRule {
  readonly cancelledSequence: number;
  readonly stopLimit: number;
  readonly stopSupported: boolean;
  readonly opening: boolean;
  readonly rejected: ReadonlySet<string>;
}

export interface StopAttempt {
  readonly operationId: string;
  readonly kind: string;
  readonly purpose: "stop" | "reconcile";
}

const uncertainStatuses = ["recovering", "blocked"];

function uncertain(subject: StopSubject): boolean {
  return uncertainStatuses.includes(subject.status ?? "");
}

function alivePurposes(
  subject: StopSubject,
  rule: StopRule,
): readonly ("stop" | "reconcile")[] {
  if (rule.stopSupported) return ["stop"];
  return uncertain(subject) ? ["reconcile"] : [];
}

function purposes(
  classed: {
    readonly subject: StopSubject;
    readonly kind: StopClass | undefined;
  },
  rule: StopRule,
): readonly ("stop" | "reconcile")[] {
  const { subject, kind } = classed;
  if (kind === "unknown") return ["reconcile"];
  return kind === "alive" ? alivePurposes(subject, rule) : [];
}

export function stopAttempts(
  subjects: readonly StopSubject[],
  rule: StopRule,
): readonly StopAttempt[] {
  const classes = stopClasses(subjects);
  return subjects
    .filter(
      (subject) =>
        rule.opening ||
        rule.rejected.has(subject.operationId) ||
        stopCount(subject, rule.cancelledSequence) < rule.stopLimit,
    )
    .flatMap((subject) =>
      purposes({ subject, kind: classes.get(subject.operationId) }, rule).map(
        (purpose) => ({
          operationId: subject.operationId,
          kind: subject.kind,
          purpose,
        }),
      ),
    );
}

export type Closure = "cancelled" | "stop-not-observed" | "stop-unconfirmed";

export interface RunClosure {
  readonly closure: Closure;
  readonly unresolved: readonly string[];
  readonly open: boolean;
}

function closureOf(
  pending: readonly StopSubject[],
  rule: Pick<StopRule, "cancelledSequence" | "stopLimit">,
): Closure {
  if (pending.length === 0) return "cancelled";
  const bounded = pending.some(
    (subject) => stopCount(subject, rule.cancelledSequence) >= rule.stopLimit,
  );
  return bounded ? "stop-unconfirmed" : "stop-not-observed";
}

export function runClosure(
  subjects: readonly StopSubject[],
  rule: Pick<StopRule, "cancelledSequence" | "stopLimit">,
): RunClosure {
  const classes = stopClasses(subjects);
  const classed = (kind: StopClass): readonly StopSubject[] =>
    subjects.filter((subject) => classes.get(subject.operationId) === kind);
  const open = classed("open");
  return {
    closure:
      open.length > 0
        ? "stop-not-observed"
        : closureOf([...classed("unknown"), ...classed("alive")], rule),
    unresolved: [
      ...open.filter((subject) => !accepted(subject)),
      ...classed("unknown"),
    ].map((subject) => subject.operationId),
    open: open.length > 0,
  };
}
