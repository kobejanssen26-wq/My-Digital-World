# State mapping rules

Task status is derived only from observed events. Unknown stays unknown.

| Evidence | Effect |
|---|---|
| `prompt.submit` (new work) | task **Received** → Project Intake |
| read-only tools (Read/Grep/Glob/WebSearch…) before any change | **Planning** (investigating) → Planning Office |
| modifying tool (Edit/Write, mutating shell, build/test/deploy command) succeeded | **In development** → Development District; project becomes "developing" |
| test command started (`tool.start`) | **Testing**, test status *running* → Testing Center |
| test command exited OK / failed | test status *passing* / *failing*; failing ⇒ **Needs attention** → Repair Workshop (stays until tests pass) |
| build/lint failed, deploy failed, 3 consecutive tool failures | **Needs attention** |
| permission prompt / elicitation notification | **Waiting for input** → Planning Office |
| user interrupts a tool | **Waiting for input**; a running test returns to *unknown* |
| `Stop` | **Ready for review** (a question becomes **Completed – answered**); with failing tests stays Needs attention |
| `StopFailure` | **Failed** |
| `SessionEnd` after Ready for review and no failing tests | **Completed**, basis `claude_finished_session_closed` ("Claude finished and the session was closed — not verified by tests or deployment") |
| `SessionEnd` with in-flight work | **Interrupted** |
| no event for 30 min while active | session **Lost**, in-flight tasks **Interrupted**; the UI shows *Disconnected* immediately |
| dashboard "Mark complete" / "Reopen" / "Pause" | recorded as `user.action` events |

Separate fields: task status, **test status** (unknown/running/passing/failing), **deploy status** (none / ready / running / command_succeeded / failed — `ready` = tests passing + deploy tooling detected + ready for review; `command_succeeded` means a deploy command exited 0, **the live site is never verified**), project lifecycle (new/active/attention/idle/paused/completed). Completed ≠ tested ≠ deployed. Progress is shown as stage labels and activity indicators; there are no percentages.

Location (Deployment Center needs passing tests + deploy tooling; Completed needs no live session) is a pure function of this state (`packages/shared/src/reducer.ts: deriveBuilding`), persisted in `project_locations`, and animated along the road graph only when the persisted location changes.
