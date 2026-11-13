export const queueUsage = `Usage: cloving queue [--workflow <id>] [--json]
       cloving queue resume [--workflow <id>] [--command-id <id>] [--json]
       cloving queue drain [--workflow <id>] [--command-id <id>] [--json]
       cloving queue lanes <n> --workflow <id> [--command-id <id>] [--json]

Shows the state of the queue: running, stopped, draining or drained, with the busy lanes. With several queues, --workflow <id> is required. With one queue, it is optional.
lanes writes 1 to 16 lanes to the private queues setting and applies it now. Fewer lanes keep runs in work.
A stopped queue shows the reason and the failed runs in a row.
resume sets the failure count to 0 and ends a stop or a drain. The next queue check can start a run.
drain starts no new queue run. The runs in work continue to their end.
When no lane is busy, the queue records the drain time, writes "Queue drained" one time and shows drained.
A drained queue is a safe point for a restart. A drain stays in place after a restart.
The queue keeps the newest 32 command IDs. A repeated kept ID does not apply the command again.
The reply shows the current state. A different command with a kept ID is refused.
`;
