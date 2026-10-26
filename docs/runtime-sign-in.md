# Runtime sign-in

Computer owners and Workspace owners/admins can sign supported runtimes in or out from the
Computer's runtime popover. Authentication runs on that Computer. The browser receives only
private progress and the masked account; the native runtime keeps its credentials locally.
Claude Code and Codex use their existing native browser/code flows.

The runtime popover’s **Refresh** re-reads both usage and native login status. A runtime can be
signed in even when its account does not support reading usage. The previous result stays visible
until the Computer replies; the browser then reloads the Computer’s login report. If the fresh
login report cannot be recorded, Refresh reports an error instead of claiming success.

## Kiro enterprise accounts

This enterprise flow currently supports macOS and Linux. Windows does not advertise the
enterprise capability and rejects enterprise login before starting a native process.

Choose Kiro **Sign in**, enter your organization's IAM Identity Center **Start URL** and
**AWS Region**, then open the displayed verification page and enter its device code.
The same native login process waits for authorization and verifies the resulting identity.
Closing the dialog cancels that attempt. A failed or expired attempt can be started again.
The Start URL and Region apply only to that attempt; CoForge does not save them as settings.

The Computer must advertise `runtime-auth:kiro-idc:v1`. Older Computers return **needs upgrade**;
deploy the compatible Web before upgrading Computer. Roll Computer back before Web.
No database migration is required. Existing Claude/Codex intents remain compatible.

Organizations may disable device-code sign-in. External identity-provider flows that require
a local browser callback are outside this first enterprise flow. When the CLI explicitly
reports either limitation, the dialog explains it; other errors retain their own failure.
An unrecognized native prompt stops the attempt instead of guessing an answer.
The adapter was developed against Kiro CLI 2.33.1; other versions require native-flow validation.

Signing out clears the CLI's stored login for the local OS user, across workspaces. An API key
or a running agent may still provide authentication; sign-out does not terminate running agents.
The final status is always re-read rather than inferred from the logout process's exit alone.

## Verification

Automated tests use fake identities and native-process fixtures, never a user's real login.
Manual enterprise acceptance must separately cover a real IAM Identity Center account's
success, denial, cancellation, expiration, and the organization's device-flow restrictions.
Check the form and progress dialog on desktop/phone, in English/Chinese and light/dark themes.

Sources: [Kiro authentication](https://kiro.dev/docs/getting-started/authentication/),
[Kiro CLI commands](https://kiro.dev/docs/reference/cli-commands/), and
[official KiroCrew remote login driver](https://github.com/kirodotdev/KiroCrew/blob/adf26a30e9bbb0de8d8474b91840530af719c79f/src/kiro_crew/cloud/login.py).
