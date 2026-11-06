# Rescue a pull request

Copy the template into your private workflow folder, named by `workflows.folder`,
with `cloving templates copy rescue-pr`. This operator step happens outside the
application repository. Inspect `cloving templates show rescue-pr --json`, choose
the `accept` and `merge` options, apply their edits, update `selection` in
`rescue-pr/scenarios.ts`, then run `cloving workflows test rescue-pr`.

## Input

The input has the number of an open pull request of Cloving in `pullRequest`.
The optional fields are:

- `reason`: the reason that stopped the last run of the pull request.
- `issue`: the ticket as `owner/repository#number`.
- `ticketStatus`: `complete` or `partial`, from the last report of the original
  worker.

The `patrol` template fills all four fields. A person can start a rescue with the
number only, for example with `cloving run rescue-pr --input rescue.json` and the
file `{"pullRequest": 641}`.

## Steps

1. The GitHub `prepare` method with the payload `{"pullRequest": 641}` reads the
   pull request. It refuses a pull request that is not open
   (`pull-request-not-open`) or that is not on a `cloving/` branch
   (`pull-request-not-cloving`). Thus a pull request that a person opened is never
   rescued. Only one active run can own a pull request. While another active run
   owns it, the method gives `pull-request-claimed`. The method puts the work tree
   of that branch at the head of the pull request. A kept work tree that already
   contains the head stays as it is. Thus an unfinished merge of a stopped turn
   stays for the next turn. A kept work tree that cannot move to the head gives
   `pull-request-diverged`. The result names the target of the work tree, and all
   later effects of the run use that target.
2. A turn merges the default branch into the branch, resolves the conflicts, and
   fixes the failed CI or the review findings. The first turn gets the reason. It
   reads the failed checks and the review comments with `gh`. A later turn gets
   the output of the failed review or merge.
3. The turn runs the repository checks and commits. Then `open-pr` pushes the
   branch and finds the same pull request. A pull request with another number
   blocks the run with `pull-request-changed`.
4. The `accept` and `merge` points work as in `develop`. The merge runs the
   `beforeMerge` check and waits for CI. A failed review or merge with output
   starts the next turn. The run blocks after four rounds, or at once on
   `ci-pending`, `check-not-configured`, `merge-queue-removed`,
   `merge-queue-timeout`, or a rejection without feedback.
5. After the merge, the run closes the ticket only when `issue` is given and the
   original worker reported `Ticket status: complete`. With `partial` or with no
   status, the ticket stays open.

A failure before the merge ends the run `blocked` with the reason. The run never
changes the ticket labels before the merge.
