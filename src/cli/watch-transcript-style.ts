export const transcriptStyle = `
.transcript { margin: 12px 0; }
.transcript .code-head { display: flex; gap: 10px; align-items: center; }
.transcript-toggle, .transcript-jump, .transcript-earlier { font: 500 12px/1.4 var(--font-code); color: var(--color-code-text); background: var(--color-code-line); border: 0; border-radius: var(--shape-cut); padding: 3px 10px; cursor: pointer; }
.transcript-link { color: var(--color-code-muted); }
.transcript > .meta, .transcript > .bad { padding: 8px 12px; margin: 0; }
.transcript-earlier, .transcript-jump { margin: 8px 12px; }
.transcript-lines { max-height: 32rem; overflow: auto; padding: 4px 12px 12px; font: 400 12px/1.6 var(--font-code); }
.transcript-lines .entry { margin: 6px 0; padding-left: 10px; border-left: 3px solid transparent; }
.transcript-lines pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; color: inherit; background: none; }
.transcript-lines .entry.assistant { border-left-color: var(--color-code-line); }
.transcript-lines .entry.thinking, .transcript-lines .entry.notice, .transcript-lines summary { color: var(--color-code-muted); }
.transcript-lines .entry.tool-call > summary { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.transcript-lines .entry.error { border-left-color: var(--color-bad); }
.transcript-lines .entry-mark { color: var(--color-bad); font-weight: 600; }
.transcript-lines .entry.result { color: var(--color-accent); border-left-color: var(--color-accent); }
.transcript-lines .entry-cut { margin: 2px 0 0; color: var(--color-warn); }
`;
