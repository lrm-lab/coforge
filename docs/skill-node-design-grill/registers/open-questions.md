# Open Questions

| ID | Question | Prerequisite | Owner | Next trigger | Status |
|---|---|---|---|---|---|
| OQ-001 | Should the archived ADR-0043 implementation gate be reopened for a named product delivery? | Current-branch and cross-repository evidence required by the coverage audit, plus explicit requester authorization. | requester | Evidence package is complete. | blocked |
| OQ-002 | What is the intended disposition of the standalone `ketsuzhou/skill-node-design-grill` repository now that this archive lives in CoForge? | Confirm whether it remains a backup or should be archived/deleted. | requester | Repository ownership decision. | open |
| OQ-003 | What are the default Hint delivery TTL and cooldown durations? | Q119-A names both mechanisms and leaves the numbers unset. ADR-0033 explicitly excludes choosing them. The implementation value of 300 seconds is not a formal decision. | requester | A cycle reopens Q119 numeric defaults, or a named delivery needs the number. | open |

Close or supersede a question from the cycle that settles it; do not silently delete it.
