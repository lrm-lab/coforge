# Shared agent skills

These rules apply to the entire repository; the root `AGENTS.md` links here.

- Project skills live in `.agents/skills`; `skills-lock.json` records their upstream source and content hash.
- The repository keeps no separate glossary. Do not create `CONTEXT.md`.
- Review a change from an independent context against an explicit fixed point (the commit range), for both standards and spec. The reviewer follows [the review conventions](../../REVIEW.md) for what counts as a failure and how to report it. A coordinator must include this instruction in every reviewer brief: perform the assigned review directly; do not delegate it again or spawn additional reviewers.
- Use `coforge-release` when inspecting or executing a cloud test deployment, publishing a local Computer installation candidate assembled from the `coforge-computer` and `coforge-daemon` packages, preparing or executing an exact-artifact production promotion, verifying release evidence, or rolling back. [`docs/release/README.md`](../release/README.md) is the overview of the canonical release contract, with one topic file per concern under `docs/release/`; the Skill is only its execution layer.
- When comparing CoForge with the reference Computer, the reference is its latest shipped binary, resolved when the research starts, not an npm release or a version copied from an earlier note. Read [the reference Computer research guide](reference-cli-research/README.md) first; it records how to recover its source, and requires citing the version examined.
- No issue tracker is configured. Give every reviewer an explicit spec source (the task thread and its recorded decisions); if there is none, ask the requester instead of inferring one.
