# Patrol

Copy the template into your private workflow folder, named by `workflows.folder`,
with `cloving templates copy patrol`. Copy `rescue-pr` and `answer-review` into
the same folder with `cloving templates copy rescue-pr` and
`cloving templates copy answer-review`, because the patrol hands off to them. This
operator step happens outside the application repository. Inspect
`cloving templates show patrol --json`, choose the `act` option, apply its edit,
update `selection` in `patrol/scenarios.ts`, then run
`cloving workflows test patrol`.

The default schedule runs every 1800 seconds (30 minutes) with `{}` input. The
scheduler skips a slot while the patrol runs, including its decision wait.

## The operator command `patrol-status`

Set `CLOVING_COMMANDS` to a JSON argv array for the read-only command
`patrol-status`:

```json
{
  "patrol-status": ["<absolute-patrol-status-wrapper>"]
}
```

Replace the placeholder with the absolute path of your wrapper. Bare executable
names are refused by command configuration.

The command prints one JSON array. Each item is one open pull request of
Cloving, with the last run on its branch:

```json
[
  {
    "number": 641,
    "branch": "cloving/task-0123456789ab",
    "state": "blocked",
    "active": false,
    "reason": "merge-conflict",
    "head": "0123456789abcdef0123456789abcdef01234567",
    "score": 4,
    "issue": "acme/demo#627",
    "ticketStatus": "complete"
  }
]
```

| Field          | Value                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------- |
| `number`       | The number of the pull request.                                                           |
| `branch`       | The head branch. The patrol uses only `cloving/` branches.                                |
| `state`        | The state of the last run on the branch, for example `blocked`, `failed` or `completed`.  |
| `active`       | `true` when a run of Cloving is active on the pull request.                               |
| `reason`       | The reason that stopped the run. A candidate must have a reason.                          |
| `head`         | The head commit, 40 or 64 lowercase hexadecimal characters. A candidate must have a head. |
| `score`        | The last review score from 0 to 5, or `null`.                                             |
| `issue`        | The ticket as `owner/repository#number`, or `null`.                                       |
| `ticketStatus` | `complete` or `partial` from the last report of the original worker, or `null`.           |

A candidate is an item with `state` `blocked` or `failed`, `active` `false` and a
`cloving/` branch. The patrol ignores all other items. Thus a pull request with an
active run is never a candidate, and the patrol never rescues a pull request that
a person opened. A failed command, invalid JSON or an invalid field blocks the
pass before a decision or a handoff.

Build the wrapper from the run list of Cloving and the open pull requests, for
example from `gh pr list --state open --json number,headRefName,headRefOid`. Read
`ticketStatus` from the `Ticket status:` line of the last report of the original
worker. Leave it `null` when that line is not available.

## Review candidates

An item with `active` `false`, a `cloving/` branch and a `state` that is not
`blocked` or `failed` can be a review candidate. For at most eight such items in
each pass, the patrol reads the pull request with the GitHub method
`review-threads`. Each pass starts the reads at a different item of the list. The
cycle id of the pass selects the first item, so that the patrol also reads the
items after the first eight. The item is a candidate when all these conditions
are true:

- The pull request has an open review thread whose last comment is not by the
  GitHub account of the operator, and no `answer-review` run took that last
  comment (`answered` is `false`).
- No new comment came in the last 5 minutes (`quietSeconds` is 300 or more).

The patrol hands off each candidate to `answer-review` with the input
`pullRequest`, with no decision. One pass hands off at most four answers. A
failed read skips the pull request. The GitHub method `record-answered` keeps the
last comment of each thread that a run took. This record stops a second run on
the same comments, also when the last run left a thread without a reply. A thread
that a run did not take stays a reason for the next run.

## The `act` point

- **Ask a person first** (the default): one decision lists the candidates with
  the number, the branch, the state, the reason, the head and the review score.
  Answer the numbers to rescue, separated by commas, or `all`, or `none`. A
  denial, an expiry or another answer hands off nothing. Nothing is handed off
  before the decision.
- **Hand off at once**: the patrol hands off a rescue for each candidate without
  a decision.

## Limits

One pass hands off at most four rescues, so that rescues do not take every lane.
Each rescue is a `rescue-pr` run with the input `pullRequest`, `reason` and, when
known, `issue` and `ticketStatus`. The chain limit counts only the depth of a
chain: each run counts its ancestors, not its siblings. Thus the four handoffs of
one pass do not reach the chain limit.

The patrol does not wait for its rescues. A rescue that runs makes its pull
request active, so the next pass skips it. With **Hand off at once**, a pull
request whose rescue also ends `blocked` or `failed` is a candidate again at the
next pass. Leave such a pull request out of the `patrol-status` output if you do
not want another rescue.
