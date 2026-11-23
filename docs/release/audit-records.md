# Audit records

Keep both the platform's deployment or publication record and the durable
release record defined in [Release identity and evidence](evidence.md) for every staging release, production promotion,
failed attempt, and rollback. For routine production, record the release
coordinator, the `#release` announcement, exact candidate and verification
evidence, workflow run, and observed result. Record any separate approval
with its approver, reference and exact scope. Keep the previous and resulting
identities, verification evidence, rollback trigger and result, and the final
observed state. An interrupted release is a recorded outcome, not a missing entry. The
records must reveal the selected and next rollback identities without relying
on an Agent's private memory, and must never contain secrets. Local records also
preserve the previous and resulting version strings, the manifest's per-platform
SHA-256 checksums, authenticated storage size and checksum evidence, and the unsigned
private-origin guard result. Independently run CDN acceptance evidence may be
linked, but is not required for routine publication or rollback.
