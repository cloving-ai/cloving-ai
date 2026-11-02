# Review day

Copy the template into your private workflow folder, named by `workflows.folder`,
with `cloving templates copy review-day`. This operator step happens outside the
application repository. Inspect `cloving templates show review-day --json`, choose
the two options, apply their import and declaration edits, update `selection` in
`review-day/scenarios.ts`, then run `cloving workflows test review-day`.

The default schedule runs every 86400 seconds with `{}` input. The scheduler
skips a slot while the review runs, including its decision and child-run waits.
Use the scheduled copy as the single daily reviewer; avoid starting parallel
manual copies. A failed command or invalid JSON blocks the run before any turn,
report or issue. Unavailable metrics stay unavailable, never zero.

Set `CLOVING_COMMANDS` to JSON argv arrays for these three read-only commands:

```json
{
  "report": [
    "<absolute-cloving-executable>",
    "report",
    "--since",
    "24",
    "--json"
  ],
  "reviews": [
    "<absolute-gh-executable>",
    "issue",
    "list",
    "--state",
    "all",
    "--label",
    "cloving: review",
    "--limit",
    "7",
    "--json",
    "number,url,body,createdAt"
  ],
  "improvements": ["<absolute-improvements-wrapper>"]
}
```

Replace the executable placeholders with absolute paths (`command -v cloving`,
`command -v gh`, and your wrapper's absolute path). Bare executable names are
refused by command configuration.

`report` runs `cloving report --since 24 --json`. `reviews` supplies the last seven
review issues as an array, newest first. `improvements` must read all open issues
with `cloving: improvement` and return an array with `number`, `url`, `body` and
the stable `loop` identifier for each issue. Use a local read-only wrapper to
extract that identifier from its body; include the metric, before measurement,
change date, check date and after evidence in the body. Missing loop identifiers
prevent further proposals until clarified. Never truncate the open-issue list.

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
decision. Failed cleanup blocks the run. Retain `github` in capabilities and
`discard` in methods for all options, including `post.result` with `next.nothing`.

Analyze and critique use the same nine rules and all three command outputs.
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
