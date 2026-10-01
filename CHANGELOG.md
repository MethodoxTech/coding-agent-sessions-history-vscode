# Changelog

## 0.2.0

- The session list no longer waits for indexing. Sessions indexed last time
  show at once, a cold index fills in newest first while it runs, and opening a
  session never waits for the scan to finish
- Codex rollouts index several times faster. Tool output and item events, most
  of a rollout's bytes, are recognised and skipped without being parsed
- A running Codex session is no longer re-read from the start on every change;
  the index carries on from where it last stopped, so a 100 MB rollout updates
  in milliseconds
- Inline images in Codex rollouts — screenshots in tool output and pasted
  images — are shown as `[Image]` instead of base64, and are left out of memory
  and deep search
- Failed commands are flagged in newer Codex rollouts, which record the exit
  code as JSON inside the tool output
- Transcripts are read faster in general, which also speeds up opening a
  session and deep search
- The index cache is saved during a long first scan, not only at its end

## 0.1.0

Initial Coding Agent Sessions History release, based on Claude Code Sessions History 0.1.3.
