# Answer review

Copy the template into your private workflow folder, named by `workflows.folder`,
with `cloving templates copy answer-review`. This operator step happens outside
the application repository. Inspect `cloving templates show answer-review --json`,
choose the `resolve` option, apply its edit, update `selection` in
`answer-review/scenarios.ts`, then run `cloving workflows test answer-review`.

The workflow answers the open review threads of one pull request of Cloving that
no run owns. The input is `{"pullRequest": N}`. The `patrol` template hands off
to `answer-review` with this input. A person can also start a run with this input.

## Steps

1. The GitHub method `prepare` with `{"pullRequest": N}` puts the work tree on the
   branch of the pull request. It refuses a pull request that is not open, a
   branch that is not a `cloving/` branch, and a pull request that an active run
   owns.
2. The GitHub method `review-threads` reads all pages of the review threads
   through the GraphQL field `reviewThreads`. For each thread it reads the first
   comment and the last 10 comments. When the last 10 comments have no comment
   of a bot, the operator or a member, it reads earlier pages of 50 comments
   until it finds one. After 10 such pages it fails with `review-threads-limit`.
   It returns the threads that are not resolved and whose last comment is not by
   the GitHub account of the operator. Each thread has its path, its line, its
   outdated flag, a bot flag, an `answered` flag and its comments with the author
   and the time. The author of the first comment sets the bot flag. The
   `answered` flag is `true` when an earlier run took the last comment of the
   thread. The threads with `answered` `false` come first. The method also
   returns the top-level comments of people since the last commit. When no
   thread is open, the run ends with no turn.
3. The run takes at most ten threads with `answered` `false`. When all open
   threads have `answered` `true`, the run takes them again, so that a person can
   start a new run after a blocked run. The GitHub method `record-answered` keeps
   the last comment of each thread that the run takes. The record keeps only the
   last comments of open threads. It has no size limit, so it does not lose an
   open thread. The patrol does not hand off the same comments again. A thread
   that the run does not take stays open for the next run.
4. One turn gets the pull request, the command for its diff, and the threads that
   the run takes, with the labels `T1` to `T10`. For each thread the turn fixes
   the code with a failing test first, or it explains why no change is needed. The
   turn runs the developer gate and commits. It ends with one line for each thread:

   ```text
   Thread T1: fixed <short SHA>
   Thread T1: no change <reason>
   Thread T1: question <text>
   ```

5. When the turn made a new commit, the GitHub method `open-pr` pushes the branch
   to the same pull request.
6. The GitHub method `reply-thread` posts one reply to each thread with a line:
   `Fixed in <short SHA>.` or `No change is needed: <reason>`. A thread with
   `question` opens a decision with the question. The reply has the answer of the
   person. A denial, an expiry or an empty answer leaves the thread without a
   reply. The replies of `fixed` and `no change` come before the questions.
7. The `resolve` point decides if the GitHub method `resolve-thread` resolves a
   thread.
8. After a push, the GitHub method `wait-review` asks for a new Greptile review in
   the same way as in `develop`, so that a fixed finding gets a fresh score. The
   score goes in the report of the run. A review that does not come does not
   block the run.

## Rules

- Each reply goes through the same privacy check as an issue body. A reply with
  a local path, a private text, an email address, a mention or a link to an
  issue of another repository is refused, and the run ends `blocked` with the
  privacy reason.
- Each reply ends with a hidden marker of its operation. When the service stops
  after GitHub accepts a reply, the restarted operation finds the reply by its
  marker and does not post a second reply.
- A `fixed` line must name a commit that the turn made. These reports block the
  run before a push or a reply:
  - A report with no line for a thread that the turn got.
  - A report with a `fixed` line for an unknown commit.
  - A report with a commit entry that is not text.
  - A report with uncommitted files. The run ends `blocked` with the reason
    `uncommitted-change`.
- The workflow reads only the comments of bots, of the operator and of people with
  the association `OWNER`, `MEMBER` or `COLLABORATOR`. A comment of another
  person does not reach the turn and does not start a run.
- The workflow does not merge. The merge stays with `develop`, `rescue-pr` or a
  person.

## The `resolve` point

- **Resolve bot threads after a fix** (the default): the workflow resolves a
  thread of a bot after its fix is pushed. It never resolves a thread of a
  person: that person resolves it.
- **Never resolve**: the workflow replies to each thread and leaves every thread
  open.
