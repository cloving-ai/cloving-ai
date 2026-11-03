# Develop template decisions

`template.json` describes the six decisions used by the develop template.
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
of three fix rounds. Pending CI and an unconfigured check stop the run.

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
its requirements, and test ten complete configurations through the folder
loader and the installed package, covering every option.

`develop/turn.ts` implements the development turn for either a resolved
`ticket` or a task `prompt`. It calls the public protected effect helper and
returns the broker result unchanged. Its `feedback` takes the previous
result's `reason`, full `output`, and `remaining` items. Rounds 1 through 4
allow the initial turn and three fix turns; the workflow must stop after that.
`develop.test.ts` exercises this helper with `cloving/workflows/testing`.

`developReport` in `develop/report.ts` runs the turn again once when its result
has the reason `claude-turn-interrupted`. This occurs when the daemon cannot
resume an open turn after a restart. The new turn has the same target, so the
daemon gives it the same work tree. Its scope adds the key `continuation`, and
its prompt tells the worker that the earlier turn stopped before its report.
The worker checks the work tree, the commits since the start of the round, and
the ticket before it continues.

After a second interruption of the same turn, `developReport` returns a blocked
outcome with the reason `turn-interrupted`, and the run labels the ticket
`cloving: blocked`. `develop/round.ts` and `develop/local.ts` return this
outcome before they use the report. Other results that are not `completed` fail
the run. The effect limit of 31 includes one more turn in each of the four
rounds.
The package tests also load small compositions of this helper through folder
admission for both input forms and test both forms in complete workflows.

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
no additional verification, Greptile at 5/5, merge after checks, and return
partial work to the queue.
Selecting `person` at selection, acceptance and partial work, with `local` at
merge, describes the existing reviewed local-branch process.

The `verify` point defaults to `none`, preserving the current round and
declaration. Select `red-green` with either `green` or `person` at `merge`.
Import `verifyRedGreen` from `develop/red-green.ts` in `develop/round.ts`.
Immediately after `openPull`, before constructing the review subject or
calling `acceptWork`, add:

```typescript
const verification = await verifyRedGreen({
  cycleId: input.cycleId,
  head: pull.commit,
  round,
});
if (verification !== null && "kind" in verification) return verification;
if (verification !== null)
  return repair({ cycleId: input.cycleId, round, report, result: verification });
```

Add `"command"` to `workflow.capabilities`, `"commands": ["red-green"]` to
`workflow`, and `"command": ["run:red-green"]` to `methods` in
`develop.declaration.json`. Increase `workflow.effectLimit` by 4, from 31 to
35, allowing one verification command in each of the four development rounds.
Set `selection.verify` to `"red-green"` in `develop/scenarios.ts` and run the
option tests. The local merge option does not support this verification.

The helper calls the operator command on the pull request's immutable head with
scope `{ phase: "verify", operation: "red-green", round }`.
`accepted` and `no-test-change` proceed to review. `false-red`,
`red-not-assertion`, `skipped-test` and `green-failed` pass the verdict and full
tool output through `repair` to the next fix turn. These fixes share the
existing four-round limit with review and merge fixes. `prepare-failed`, a
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
