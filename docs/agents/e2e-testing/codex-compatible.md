# Codex compatible provider acceptance

The acceptance uses two installed Linux Computers, real Codex app-server processes, and a private Web stack. A local Responses fixture sends a unique reply through the Agent. No OpenAI account or real provider key is required.

## Prepare the guest

1. Start a disposable Linux VM with two separate OS users and systemd user managers. Prepare Bun, Git, the pinned build tools, Codex, and, for the browser phase, `agent-browser` with a local Chromium. Use new Codex homes with no `auth.json`.
2. Build the current Computer from the Web checkout and a legacy Computer from a commit before compatible-provider capability. Use `scripts/e2e/build-computer-fixture.ts` in each checkout and keep their generated manifests. Install with the native `coforge-installer` and approve both Computers in the private `dev-user` workspace. Follow the installer and HTTPS portions of [native Linux setup](native-linux-setup.md). Use `setup --one-shot --fresh --yes --workspace dev-user --json` for initial registration. Keep the device-code output private.
3. Start the repo's private E2E infrastructure and build and serve Web from the current Computer's source commit using `scripts/e2e/start-e2e-web.sh`. Use trusted loopback HTTPS and route the Web and Centrifugo paths through it. Trust the local CA in the Computer, the harness, and Chromium. Use the actual Computer registrations and capability leases.
4. Install `scripts/e2e/codex-compatible-codex.sh` as `bin/codex` under the current user's `CODEX_INSTALL_DIR`. Point `COFORGE_CODEX_E2E_REAL_CODEX` at the separate real Codex binary. Import the variables that the service uses into its user systemd manager before starting Computer.
5. Once dependencies and builds are in place, block external egress for the whole VM, including forwarded/container traffic. Keep loopback and the private service bridge available. The tests probe a hostname and a literal IP before sending any fixture credential and again after the completed flow.

Set the environment in the current Computer's OS user and run the script from the built Web checkout. The probe and evidence directories must already exist under that user's real home.

| Variable | Value |
| --- | --- |
| `COFORGE_CODEX_E2E_DISPOSABLE` | `1` |
| `COFORGE_CODEX_E2E_WEB_URL` | Trusted loopback Web origin, for example `https://localhost:8791` |
| `COFORGE_CODEX_E2E_CURRENT_COMPUTER`, `COFORGE_CODEX_E2E_LEGACY_COMPUTER` | The two real registration IDs |
| `COFORGE_CODEX_E2E_CURRENT_MANIFEST`, `COFORGE_CODEX_E2E_LEGACY_MANIFEST` | The manifests of the installed fixtures |
| `CODEX_INSTALL_DIR` | The current user's probe wrapper installation, imported into systemd |
| `CODEX_HOME` | Fresh Codex home, also imported into systemd |
| `COFORGE_CODEX_E2E_REAL_CODEX` | Real Codex executable path, also imported into systemd |
| `COFORGE_CODEX_E2E_PROBE_DIR` | Private directory for launch evidence, also imported into systemd |
| `COFORGE_CODEX_E2E_EVIDENCE_PATH` | A distinct JSON path for each run and phase |

## Run and read the phases

```sh
COFORGE_CODEX_E2E_EVIDENCE_PATH="$HOME/fixture-evidence/backend.json" \
  codex-guard --timeout 540 -- scripts/e2e/run-codex-compatible.sh backend
COFORGE_CODEX_E2E_EVIDENCE_PATH="$HOME/fixture-evidence/browser.json" \
  codex-guard --timeout 240 -- scripts/e2e/run-codex-compatible.sh browser
```

- **Backend** covers real Web creation, a matching provider request and persisted Agent reply, missing and wrong credential controls, legacy capability refusal, launch environment cleanup with inherited synthetic values, the new/same/new Codex thread sequence, and API-provider billing. The two default-mode entries confirm native thread creation. Compatible turns confirm delivery through the endpoint.
- **Browser** covers the legacy chooser, the active compatible creation form, a real Agent reply that survives reload, and the API-provider billing popover. A browser pass requires the Web checkout with the compatible-provider UI.

Compare the source commit in the two receipts when recording a combined result. An incomplete receipt means the run ended before it recorded the acceptance assertions. The browser phase also saves a usage screenshot after the credential form closes. The fixture records request method, path, model, match status, and a generated trace ID. It discards request headers and bodies from evidence. Destroy the disposable VM when finished with the private Workspace and its generated credentials.
