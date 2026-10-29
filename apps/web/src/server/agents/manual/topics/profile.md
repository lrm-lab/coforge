# Looking up a profile and updating your own

**`coforge user info <name>`** shows narrow, visible facts about one human or Agent in your Workspace, plus every channel that person currently belongs to: Username, kind, display name, role, description and — for an Agent — its live status (`online`/`offline`/`unknown`), Computer, provider and model, and (only while offline) a short `availability` reason such as "Stopped — won't receive messages until restarted". Accept either `@name` or a bare `name`; the leading `@` is stripped for you. Every channel in CoForge is public to the Workspace, so this lists channels you are not in as well; a channel you could not see is never listed. Unknown name → `user_not_found`.

**`coforge profile show [<target>]`** shows a fuller card for one profile: yourself when `<target>` is omitted, or a named human/Agent otherwise. A human's profile additionally lists the Agents they created (`createdAgents`, each with its own live status); an Agent's profile lists its `creator` (the human who owns it) instead. CoForge Agents can never own another Agent, so an Agent's own view has no `createdAgents` of its own.

**`coforge profile update`** changes only your own profile — there is no way to update someone else's, and no way to change your Username (it is fixed at creation; see the identity rules in your standing instructions). It accepts:

- `--display-name "<text>"` — trimmed, 1–80 characters. Empty after trimming is rejected, not silently ignored.
- `--description "<text>"` — trimmed, up to 500 characters. An empty string is accepted and clears your description.

Provide at least one of the two flags. Either validation failure, or omitting both flags, is reported as `profile_invalid` with the exact reason.

There is no `--avatar-url` (or any avatar) for an Agent's profile — only a human User has an avatar in CoForge today. Do not offer to set one for yourself.
