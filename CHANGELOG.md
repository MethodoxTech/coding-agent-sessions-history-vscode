# Changelog

## 0.2.1

- **From you** now means what you typed. Claude Code injects notices as
  user-role messages — a background task finishing, say — and on a long session
  those outnumbered your own messages several times over, so the scope that
  claims to be from you was mostly not. They arrive both as ordinary messages
  and as queued commands, and both routes are now recognised
- Injected notices get their own **Notifications** scope, and are labelled and
  styled as notices rather than as something you wrote. They still appear under
  **All messages**, since they record what actually happened
- Session message counts separate the two, and a session is never titled after
  a notice that happened to arrive before your first message
- Codex sessions are unaffected; their transcripts carry no such notices

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
