# Develop template decisions

`template.json` describes the seven decisions used by the develop template.
The default workflow in `develop.ts` accepts the declared ticket input, selects
from the queue, opens a pull request, waits for Greptile at 5/5, and calls
`mergeWhenGreen` with `check: "beforeMerge"`. Its declaration and helper files
pass folder admission, including compilation with the Workflow SDK in a packed
installation. Copy this directory's contents into a workflow folder.

The host supplies `{ cycleId, repository, input: { ticket: { id, text } } }`.
`develop/report.ts` extracts the resolved text and preserves the worker's ticket
status. `develop/round.ts` composes development, review and merge. A failed
review or repairable merge result gives its full output and remaining work to
the next worker turn. Review, local-check, conflict and CI fixes share a limit
of three fix rounds. At that limit, the default `recovery` option asks a person
(see "Recovery" below). Pending CI and an unconfigured check stop the run.

`develop/pull.ts` keeps the first line of the ticket as the pull request title,
removes leading `#` characters and limits it to 200 characters. For a task with
a GitHub issue, the pull request body links that issue and names its number:

```text
Refs cloving-ai/cloving-ai#375

Cloving made this change for the ticket 375.
```

A task without a GitHub issue uses only `Cloving made this change for this task.`

`develop.test.ts` and `develop/flow-tests.ts` test the default composition through the public fake
step bridge. The alternative configurations use `develop/option-tests.ts`, with the selected
point IDs in `develop/scenarios.ts`. For an edited copy, replace the default
`flowTests` and `refusalTests` imports in `develop.test.ts` with
`optionTests as flowTests`, then run every `flowTests` scenario. Keep the shared
turn, partial-helper and interruption tests. `develop/interruption-tests.ts`
follows the selected point IDs, so it tests each configuration. Package tests apply each source edit, validate
its requirements, and test eleven complete configurations through the folder
loader and the installed package, covering every option.

`develop/next-ticket.mts` and `develop/ready-tickets.mts` are reference scripts
for `tickets.nextCommand` and `tickets.readyCommand`. The workflow does not
import them. Both use `develop/ticket-queue.mts`, which reads the open issues with
the `cloving: ready` label through `gh`. An issue is ready only when every issue
in its `Needs #<number>` lines under `## Dependencies` is closed. The `scripts`
list of `template.json` names both scripts, and `cloving templates copy` prints
the settings that use them.

`develop/turn.ts` implements the development turn for either a resolved
`ticket` or a task `prompt`. It calls the public protected effect helper and
returns the broker result unchanged. Its `feedback` takes the previous
result's `reason`, full `output`, and `remaining` items. Rounds 1 through 4
allow the initial turn and three fix turns. Rounds 5 and 6 occur only after a
person chooses "Two more rounds"; the workflow must stop after round 6.
`develop.test.ts` exercises this helper with `cloving/workflows/testing`.
The package tests also load small compositions of this helper through folder
admission for both input forms and test both forms in complete workflows.

`developReport` in `develop/report.ts` runs the turn again once when its result
has the reason `claude-turn-interrupted`. This occurs when the daemon cannot
resume an open turn after a restart. Before the daemon reports this reason, it
stops the processes of the earlier turn in the work tree. The new turn has the same target, so the
daemon gives it the same work tree. Its scope adds the key `continuation`, and
its prompt tells the worker that the earlier turn stopped before its report.
The worker checks the work tree, the commits since the start of the round, and
the ticket before it continues.

After a second interruption of the same turn, `developReport` returns a blocked
outcome with the reason `turn-interrupted`. `develop/round.ts` and
`develop/local.ts` return this outcome before they use the report. A
pull-request workflow then adds `cloving: blocked` to the GitHub issue of the
ticket. Other results that are not `completed` fail the run. The default effect
limit of 87 covers six rounds with both turns, all retries and one close of the
pull request in each round.

`develop/partial.ts` implements the person's partial-work question.
`develop/partial-choice.ts` connects its answer to a development report and the
next round, or returns a blocked outcome without opening a review or merging. `reviewPartial`
opens a question with an identity scoped to the run and round. It returns
nonempty feedback from an explicit answer, or stops. It opens no question
after the initial turn and three fix turns. The separate `develop/queue-partial.ts`
helper, `queuePartial`, forwards the issue,
merged pull request and remaining items to the protected `partial-issue`
operation, preserving its result. The GitHub worker owns partial-run history
and requeues the first two runs, then blocks the ticket from the third.
Folder-admission tests cover both helpers in the checkout and packed install.
The default workflow calls `queuePartial` after merging partial work, closes
complete issues, and reports a failed issue update in its outcome.
The person-only composition needs no GitHub capability. `develop/local.ts`
implements its round: develop, ask about partial work, review the immutable
commit, and leave the branch for the person to merge. It refuses missing or
malformed commit IDs and reports of uncommitted work. `develop/accept.ts`
contains the editable pull-request acceptance call. `promptInput` in
`develop/report.ts` adapts task text without looking up a ticket.
Only resolved ticket input supplies an issue identity for lifecycle updates.
Task text keeps its full contents, including any issue-looking lines, without
selecting an issue to label, close or return to the queue.

The first option of each point is the default: ticket input, queue selection,
no additional verification, Greptile at 5/5, merge after checks, return
partial work to the queue, and ask a person for recovery.
Selecting `person` at selection, acceptance and partial work, with `local` at
merge, describes the existing reviewed local-branch process.

The `verify` point defaults to `none`, preserving the current round and
declaration. Select `red-green` with either `green` or `person` at `merge`.
Import `verifyRedGreen` from `develop/red-green.ts` in `develop/round.ts`.
At the start of `deliverPull`, before the call of `acceptWork`, add:

```typescript
const verification = await verifyRedGreen({
  cycleId: pull.target,
  head: pull.commit,
  round,
});
if (verification !== null && "kind" in verification) return verification;
if (verification !== null)
  return {
    merged: false,
    reason: verification.reason,
    output: verification.output,
  };
```

Add `"command"` to `workflow.capabilities`, `"commands": ["red-green"]` to
`workflow`, and `"command": ["run:red-green"]` to `methods` in
`develop.declaration.json`. Increase `workflow.effectLimit` by 6, from 87 to
93, allowing one verification command in each of the six development rounds.
Set `selection.verify` to `"red-green"` in `develop/scenarios.ts` and run the
option tests. The local merge option does not support this verification.

The helper calls the operator command on the pull request's immutable head with
scope `{ phase: "verify", operation: "red-green", round }`.
`accepted` and `no-test-change` proceed to review. `false-red`,
`red-not-assertion`, `skipped-test` and `green-failed` pass the verdict and full
tool output through `recover` to the next fix turn. These fixes share the
existing round limit with review and merge fixes. `prepare-failed`, a
failed command or an invalid result blocks immediately with
`red-green-unavailable`, without a fix turn.

Register `red-green` in `CLOVING_COMMANDS` as an argument array containing the
absolute path of the installed `cloving` executable followed by `"red-green"`.
Configure the project file `.cloving/config.json`, for example:

```json
{
  "version": 1,
  "checks": {
    "redGreen": {
      "test": ["node", "--test"],
      "testFiles": ["test/"],
      "prepare": ["npm", "ci", "--ignore-scripts"]
    }
  }
}
```

The tool appends changed test paths to `test`; optional `prepare` runs in each
temporary worktree. The daemon passes this configuration as
`CLOVING_RED_GREEN`. For direct tool use, set that variable to the `redGreen`
object. The repository needs `refs/remotes/origin/HEAD` to identify the base.
Increase `CLOVING_COMMAND_SECONDS`, for example to `600`, to cover both
preparation and test runs. Optional `assertionPattern` and `skipPattern`
override the defaults for non-terminal `node --test` output. See the package
README's `cloving red-green` documentation for the tool's complete contract.

## Review panel

The `panel` option of the `accept` point replaces the single reviewer with a
panel. `reviewPanel` in `develop/panel.ts` runs one review turn for each profile
in `reviewers`, then one synthesizer turn with the profile `review-synthesis`.
The list in the option is `review-claude`, `review-codex` and `review-gemini`.
Remove one name to use two reviewers. A list with fewer than two different
names stops the run with `invalid-review-panel`.

Each reviewer turn gets the same subject:

- The ticket text.
- The pull request number and its commit, with the command
  `git diff origin/HEAD...<commit>` for the diff.
- The findings of the earlier round and their reason. In round 1, a line tells
  the reviewer that there are no earlier findings.
- The fix notes of the current round, from the report of its development turn.

Each report must end with `Review verdict: accept` or `Review verdict: change`.
The synthesizer turn gets the same subject and all reviewer reports. It lists
the findings that it keeps and the findings that it drops, with one reason for
each. It drops each finding that the current change already fixes. Its verdict
is the verdict of the panel:

- `accept` goes to the merge step.
- `change` starts a fix round. The fix turn gets the synthesizer report as its
  findings, as with the `turn` option.
- A synthesizer report without a verdict line has no findings, so the
  `recovery` point asks a person.

A reviewer turn that fails, or a result without a report, does not stop the
panel. The synthesizer gets one line that names that reviewer and its reason,
and it works with the reports that remain. When no reviewer report remains,
the synthesizer does not run, and the round ends `blocked` with the reason
`review-panel-unavailable`. A failed synthesizer turn ends the round in the
same way. A pull-request workflow then adds `cloving: blocked` to the GitHub
issue of the ticket.

To select the panel, edit `develop/round.ts`. Import `reviewPanel` from
`develop/panel.ts` in place of `acceptWork`, and import the type
`DevelopReport` from `develop/report.ts`. In `developRound`, call
`deliverPull({ round, pull, state, report })`, and add `state: DevelopState`
and `report: DevelopReport` to the request of `deliverPull`. In
`deliverPull`, replace the call of `acceptWork` with:

```typescript
const review = await reviewPanel({
  state: request.state,
  report: request.report,
  pull: pull,
  reviewers: ["review-claude", "review-codex", "review-gemini"],
});
if ("kind" in review) return review;
```

In `develop.declaration.json`, remove `wait-review` from `methods.github`. Add
`run-turn:review-claude`, `run-turn:review-codex`, `run-turn:review-gemini` and
`run-turn:review-synthesis` to `methods.claude`. Keep all four methods for two
reviewers too, because `develop/panel.ts` keeps its three reviewer calls. Set
`workflow.effectLimit` to 99. Set `selection.accept` to `"panel"` in
`develop/scenarios.ts` and run the option tests.

The limit of 99 is the static count of the panel workflow: 5 effects before
the first round, 15 effects in each of the six rounds, and 4 effects for the
blocked label. A round has two development turns, four `open-pr` attempts,
four review turns, four merge attempts, and one close of the issue or of the
pull request. `developRound` calls `finishPull` and `recover` in the two
branches of one conditional expression, so the count includes only one of the
two in each round. The `red-green` option adds 6 effects, which is more than
the operator maximum of 100. For this reason, the panel requires the `verify`
option `none`. The panel reviews a pull request, so it also requires the
`merge` option `green` or `person`.

Each profile of the panel names its own harness. Set `CLOVING_PROFILES` to a
file such as the one below, or put the same `profiles` map in the private
settings file. Install each harness that a profile names. `cloving doctor`
shows the harnesses that it finds in its `harnesses` check.

```json
{
  "profiles": {
    "review-claude": { "harness": "claude" },
    "review-codex": { "harness": "codex" },
    "review-gemini": { "harness": "gemini" },
    "review-synthesis": { "harness": "claude" }
  }
}
```

For two reviewers, configure two reviewer profiles and `review-synthesis`, and
remove the third name from `reviewers`. A reviewer name that has no profile
gives a turn that fails with `unknown-profile`. The panel then works without
that reviewer. A profile can also set `model` or `env`; the package README
describes all profile fields.

## Recovery

`develop/recovery.ts` sets `recovery` to `"person"` or `"stop"`. The default
`"person"` makes these changes:

- A `failed` result of `open-pr`, `merge` or `label` with the reason
  `git-call-failed`, `git-network-failed` or `github-network-failed` runs
  again after a `sleep` of 60, 300 and 900 seconds. The worker commit stays,
  and no new turn runs. Each retry adds the key `retry-1`, `retry-2` or
  `retry-3` to the scope, and a merge retry passes `retry` to `mergeWhenGreen`.
  When an earlier merge attempt pushed a merge of the default branch, the
  retry uses that pushed head and does not make a new merge.
- After the last retry, the run ends `blocked` with the last reason. A merge
  reason also gives the pull request link, for example
  `git-network-failed: https://github.com/acme/demo/pull/7`. A run never
  fails for these reasons.
- The second `merge-conflict` gives the fix turn a conflict prompt. The prompt
  names the conflicting files, both sides of the merge and the `CONFLICT`
  lines of git. The third `merge-conflict` opens the decision below.
- At the round limit, or after a review that does not accept and gives no
  findings, `develop/decision.ts` opens a question with the latest result and
  the pull request link. A Greptile review with a summary and no findings has
  `findings` set to 0, so it also opens the question. The answer `1` ("Two more rounds") gives two more
  rounds, up to round 6. The answer `2` ("Stop and keep the pull request
  open") ends the run `blocked` with the reason and the link. The answer `3`
  ("Close the pull request") calls the GitHub method `close-pr`, then ends the
  run `blocked` with `pull-request-closed` and the link. Any other answer, a
  denial or an expiry stops the run with the pull request open. The question
  after round 6 has no "Two more rounds" option.

Pending CI, an unconfigured check, a merge queue stop and a merge denial still
end the run `blocked` without a question.

Select `"stop"` to keep the earlier behavior: a failed GitHub effect fails the
run, and the run ends `blocked` at the round limit without a question. Local
merge supports only `"stop"`, because it has no pull request.

The workflow can read only the reason of a failed effect. For this reason, the
GitHub worker reports a `gh` call that fails with an HTTP 5xx status as
`github-network-failed`, and the template tries it again.

Each option has an `id`, `label`, `summary`, `change`, `requires` and `needs`.
`change` describes the step call or declaration edit for the setup agent.
It is guidance for editing source, rather than an executable patch.

`requires` maps another point ID to its allowed option IDs. All named points
must satisfy their requirement; any listed option for one point satisfies that
point. For example, `"merge": ["person", "green"]` requires either pull-request
merge option. An empty object imposes no additional requirement. Select exactly
one known option at each point and validate the complete selection after edits.

`needs` lists `cloving doctor` codes required by that option. The configured
workflow also needs the common runtime and harness checks reported by doctor.

Changing metadata does not change runtime behavior. The setup agent must apply
the source and declaration edits, run the workflow's scenario tests, and load
the edited configuration through folder admission before using it.
