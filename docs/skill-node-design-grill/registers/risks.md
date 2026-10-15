# Risks

| ID | Risk | Impact | Mitigation | Tripwire | Owner | Status |
|---|---|---|---|---|---|---|
| R-001 | The original standalone directory still has root-owned residual files after content moved to CoForge. | Duplicate locations can diverge. | Remove the source only after privileged cleanup; retain the GitHub backup until disposition is decided. | Source path remains after the privileged cleanup request. | requester | open |
| R-002 | Historical archive conventions can be mistaken for current CoForge repository conventions. | Incorrect authority or documentation behavior. | Treat host repository rules as controlling; use this archive as engagement evidence and link formal host sources. | A delivery cites a traceability row as its sole requirement source. | delivery owner | open |

A risk is not an unresolved product decision. Move decisions to Open Questions and intentionally excluded opportunities to Future Directions.
