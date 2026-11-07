# Release a version

Copy the template into your private workflow folder, named by `workflows.folder`,
with `cloving templates copy release`. This operator step happens outside the
application repository. Inspect `cloving templates show release --json`, choose
the `accept` and `publish` options, apply their edits, update `selection` in
`release/scenarios.ts`, then run `cloving workflows test release`.

## Input

The input has the version in `version`, for example `1.7.0`, with no `v`. The
optional field `pullRequests` has the numbers of the pull requests to wait for,
separated by commas or spaces, for example `641, #643`. A person starts a release
with `cloving run release --input release.json` and the file
`{"version": "1.7.0", "pullRequests": "641, 643"}`. An invalid version, a
duplicate number or a word that is not a number ends the run `blocked` with
`invalid-release-input` before the first step.

## Steps

1. The command wait `release-pulls` runs the command `release-status` until no
   listed pull request is open. The first check is immediate, and each later
   check comes 300 seconds after the last one. The wait stops after 604800
   seconds (7 days). Then the run ends `blocked` with `pull-requests-not-merged`.
   A pull request that closed with no merge ends the run `blocked` with
   `pull-request-closed: #643`. A run with no `pullRequests` starts at step 2.
2. The GitHub `prepare` method makes a work tree on the default branch. The
   release always starts from the default branch. A turn sets the version in
   `package.json` and in the lock file. It writes the release notes from the pull
   requests merged since the last tag, and it ends its report with the line
   `Release notes:` and the notes. A report with no notes ends the run `blocked`
   with `release-notes-missing`. The turn reads the changes with
   `git log --first-parent` on the default branch, so the notes also name
   squash merges and rebase merges. A turn has no GitHub login, so it does not
   get the list from GitHub.
3. `open-pr` pushes the branch and opens the version pull request
   `Release v1.7.0` with the release notes in its body. The point `accept` works
   as in `develop`. Then `mergeWhenGreen` runs the `beforeMerge` check, waits for
   CI and merges. A rejected review or a failed merge with output starts another
   turn with that output. The run blocks after three turns, or at once on
   `ci-pending`, `check-not-configured`, `merge-queue-removed`,
   `merge-queue-timeout` or a failure with no output.
4. The point `publish` comes after the merge. With **A person approves** (the
   default), the decision `Publish v1.7.0?` waits for a person. A denial ends the
   run `blocked` with `publish-denied`, and an expiry with `publish-expired`. In
   both cases, the run pushes no tag. With **Publish after the merge**, the run
   continues at once.
5. The command `push-tag` pushes the tag `v1.7.0` on the merge commit of the
   version pull request.
6. The command wait `release-status` runs the command `release-status` every 60
   seconds until the tag CI has published the version. It stops after 7200
   seconds (2 hours). Then the run ends `blocked` with `release-not-published`.
   A failed tag CI ends the run `blocked` with `tag-ci-failed:` and the last 240
   characters of the CI output.
7. When the version is published, the run ends `handoff_requested` with the
   promotion `v1.7.0`.

A failed step ends the run `blocked` with its reason. The run never pushes a tag
before the merge. With **A person approves**, it never pushes a tag before the
approval.

## The operator commands

The workflow holds no secret and no publish credential. The CI publish job of the
repository publishes the package with its own credential. Set `CLOVING_COMMANDS`
to a JSON object with a JSON argv array for each command:

```json
{
  "push-tag": ["<absolute-push-tag-wrapper>", "<absolute-gh-config-folder>"],
  "release-status": [
    "<absolute-release-status-wrapper>",
    "<absolute-gh-config-folder>"
  ]
}
```

Replace each placeholder with an absolute path. Bare executable names are refused
by command configuration. A command gets its input as JSON on standard input and
prints one JSON object. A command of `CLOVING_COMMANDS` gets no GitHub token and
an empty `GH_CONFIG_DIR`. Thus a wrapper that calls `gh`, or `git push` with the
credential helper of `gh`, sets `GH_CONFIG_DIR` to the folder in its argument for
those calls. The workflow never sees that folder.

### `push-tag`

The input names the version, the tag and the version pull request:

```json
{ "version": "1.7.0", "tag": "v1.7.0", "pullRequest": 650 }
```

The command reads the merge commit of the pull request, for example with
`gh pr view 650 --json mergeCommit,baseRefName,state`. It refuses a pull request
that is not merged into the default branch. Then it pushes the tag on that commit
with `git tag v1.7.0 <commit>` and `git push origin refs/tags/v1.7.0`. It prints
the tag and the full commit:

```json
{ "tag": "v1.7.0", "commit": "0123456789abcdef0123456789abcdef01234567" }
```

The command must be safe to run again. When the tag is already on the same
commit, it prints the same output. When the tag is on another commit, it fails
and pushes nothing. A failure, a different tag or an invalid commit ends the run
`blocked`.

### `release-status`

This command is read-only. The two command waits run it with two input forms.
Each check prints `{"ready": false}` while the state can still change.

The wait `release-pulls` gives the listed pull requests:

```json
{ "check": "pulls", "pullRequests": [641, 643] }
```

Print `{"ready": false}` while a listed pull request is open. When no listed pull
request is open, print the state of each one, `merged` or `closed`:

```json
{
  "ready": true,
  "value": {
    "pulls": [
      { "number": 641, "state": "merged" },
      { "number": 643, "state": "merged" }
    ]
  }
}
```

The wait `release-status` gives the tag and its commit:

```json
{
  "check": "release",
  "version": "1.7.0",
  "tag": "v1.7.0",
  "commit": "0123456789abcdef0123456789abcdef01234567"
}
```

Read the CI run of the tag, for example with
`gh run list --commit <commit> --event push --json status,conclusion,headBranch`,
and the package registry, for example with `npm view <package>@1.7.0 version`.
Print `{"ready": false}` while the tag CI runs or while the registry does not
show the version. When the tag CI passed and the registry shows the version,
print:

```json
{ "ready": true, "value": { "state": "published" } }
```

When the tag CI failed, print a short output of the failed job, for example the
name of the job and the last lines of its log:

```json
{
  "ready": true,
  "value": { "state": "failed", "output": "Job publish failed: npm ERR! 403" }
}
```

Another value ends the run `blocked` with `invalid-release-status`.
