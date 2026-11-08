# Review day

Copy the template into your private workflow folder, named by `workflows.folder`,
with `cloving templates copy review-day`. This operator step happens outside the
application repository. Inspect `cloving templates show review-day --json`, choose
the two options, apply their import and declaration edits, update `selection` in
`review-day/scenarios.ts`, then run `cloving workflows test review-day`.

The default schedule runs every 86400 seconds with `{}` input. The scheduler
skips a slot while the review runs, including its decision and child-run waits.
Use the scheduled copy as the single daily reviewer; avoid starting parallel
manual copies. A failed command, a failed issue read or invalid JSON blocks the run
before any turn, report or issue. Unavailable metrics stay unavailable, never zero.

Set `CLOVING_COMMANDS` to a JSON argv array for the read-only `report` command:

```json
{
  "report": [
    "<absolute-cloving-executable>",
    "report",
    "--since",
    "24",
    "--json"
  ]
}
```

Replace the executable placeholder with the absolute path from `command -v cloving`.
Bare executable names are refused by command configuration.

`report` runs `cloving report --since 24 --json`. A command gets no GitHub login,
so the review reads the issues through the daemon with the GitHub method `issues`.
`github issues` with `{"labels": ["cloving: review"], "state": "all", "limit": 7}`
gives the last seven review issues, newest first. `github issues` with
`{"labels": ["cloving: improvement"], "state": "open", "limit": 100}` gives the open
improvement issues. Each issue has `number`, `url`, `title`, `body`, `createdAt` and
`labels`. The lists have no pull requests. The review blocks with
`too-many-improvements` when 100 or more improvement issues are open, because the
list can then be incomplete.

The review reads the stable loop identifier of an improvement from the first body
line of the form `Loop: <loop>`. The proposal text that `idea-to-issue` gets starts
with that line. Keep it in the ticket, and include the metric, before measurement,
change date, check date and after evidence in the body. An improvement without a
loop line prevents further proposals until clarified.

A copy from an earlier version declares the commands `reviews` and `improvements`
and keeps that behavior. A `gh` command has no GitHub login, so `cloving doctor`
warns with `command-gh-no-login`. Copy the template again to use `github issues`.

Before enabling the schedule, add a turn profile for this workflow with
`maxBudgetUsd` and read-only `allowedTools`. Configure a
Claude profile `reviewDay` with `workflows: ["review-day"]`, `maxBudgetUsd: 1` and
`allowedTools: ["Read", "Glob", "Grep"]`. Change the turn helper's method and its
declaration entry from `run-turn` to `run-turn:reviewDay` to use that profile.
The default unprofiled method does not apply the named profile's budget. The two
turns return JSON in their final summary; they need no write or shell tools.
Set the budget to your chosen per-turn limit.
Both turns must keep their complete serialized JSON within 12000 characters,
including escaping, below the worker's 16000-character summary limit. Condense
repeated prose while retaining every required section, evidence link and removal
reason. Oversized or incomplete JSON blocks the run before posting.

After the turns, including a failed turn or invalid report, `github discard`
removes this run's temporary worktree and branch before posting or waiting for a
decision. Failed cleanup blocks the run. Retain `github` in capabilities, and `issues` and
`discard` in methods for all options, including `post.result` with `next.nothing`.

Analyze and critique use the same nine rules and all three facts: the compact
`report` output and the two issue lists.

The `report` output grows with the work of the day, so the turns do not read all of
it. Before the turns, the workflow makes a compact form of the report. The compact
form keeps these parts:

- `window` and `semantics`.
- Each metric of `metrics`, `quality`, `ci` and `operator`, with its status, value,
  unit, comparison value, 7-day baseline and mark. The names of the last three
  sections start with `quality.`, `ci.` and `operator.`.
- `count`, the number of evidence items of each metric, in place of its evidence
  list. The baseline also has no evidence list.
- The unit from the metric name: `minutes`, `hours`, `usd`, `share`, `score` for
  review scores, else `count`.
- `jobLogs` of `quality`.
- The totals of `runCosts`: `runs`, `knownSpendUsd`, `runsWithoutCost` and
  `mostCostly`, the five most costly runs.

The turns do not read `sources`, `completedTicketCosts`, `coverage` or an evidence list.

The prompt of each turn has at most 48000 bytes of UTF-8. The worker refuses a text
above 65536 bytes. When a prompt is larger than 48000 bytes, the workflow leaves out
the lists in this order until the prompt fits:

1. The review issues.
2. `runCosts.mostCostly`.
3. The improvement issues.

The workflow always keeps the numbers. The `omitted` field names the lists that the
workflow left out, and the turn treats them as unknown, not as empty. The critique
checks of the workflow always use the complete improvement list. When the prompt
with no lists is still larger than 48000 bytes, the run ends `blocked` before that
turn with the reason `review-input-too-large: <size> bytes, limit 48000`.

Critique is a separate turn. It removes unsupported claims, lists removals,
compares every open improvement before and after its change, and gives keep,
reverse or continue at the check date. The workflow also removes proposals
without evidence or for a loop with an open improvement, caps the list at three,
and refuses additions or rewrites by the critique. The report has the fixed
Facts, Went well, Went badly, The constraint, Improvements in progress, Proposals,
Watch list and Removed by the critique sections.

Posting requires nonblank `privateTexts` and uses the existing privacy check on
the exact rendered report. `post.result` keeps the `report` field in the durable
SDK run return value. `cloving status` shows completion metadata and does not
display that field.
With proposals, one question accepts a single number or `none`. A denial, expiry
or ambiguous answer starts no child. `next.nothing` records the choice and stops.

For `next.idea`, copy `idea-to-issue` into the same private workflow folder and
select its **next.nothing** option. Its default starts development and its queue
option adds `cloving: ready`; neither is suitable for review proposals. The child
must only write the ticket, keep the proposal's evidence, loop, metric and check
date, and leave queue selection to the operator. The review reads the issue
number from its `issue-N` outcome after `waitForRun`, then adds only
`cloving: improvement` to that new issue. Earlier issues and labels stay untouched.
A later review reports the verdict; applying or reversing a change remains an
operator decision.
