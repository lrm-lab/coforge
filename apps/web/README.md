# web

CoForge's Web UI and backend control plane. This package is a modular monolith
built with TanStack Start and Bun. Its UI foundation is Untitled UI with
React Aria, Tailwind CSS v4, and Untitled UI icons.

Components use Untitled's semantic tokens with the CoForge brand overrides.
See the [product design guidance](../../docs/design/README.md) and
[design tokens](../../docs/design-tokens.md). Light and dark modes are both
supported. The public homepage retains its installed Spell and Magic UI motion
components; theme adaptation belongs at their call sites, not in upstream source.

Internationalization follows TanStack Start's official Paraglide integration.
English and Simplified Chinese messages live under `messages`; locale-aware
URLs, SSR request handling, and `<html lang>` are generated through Paraglide.

Browser login is CoForge's own page at `/login`, and the Web server signs people in against the
Authing user pool through Authing's Authentication API (v3); the browser never goes to an Authing
page. A person signs in with a verification code sent by SMS (a mainland China mobile number) or
email, or with their email and password. The first code sign-in for a phone number or email makes
the account (Authing's `autoRegister`), which then goes to the name step: there is no separate
sign-up form. A person who has no password (an account made with a code) or forgot it sets one on
`/login/reset-password`, reached by "Forgot password?" under the password form: a code sent to the
phone number or email (the same send limits as a sign-in code) and the new password, 8 to 128
characters, go to Authing in one server call, so its reset token never reaches the browser. Asking
for the code answers the same whether or not an account has the destination (Authing's refusal of an
unknown one is only logged), and nobody is signed in by it. A password signs in by email; a phone
number signs in with a code. Copy `apps/web/.env.example` to `apps/web/.env` and set
`AUTHING_APP_SECRET` plus a random `COFORGE_SESSION_SECRET` of at least 32 characters. Do not
commit the secret. `AUTHING_ISSUER` is the app's OIDC issuer (`https://<app>.authing.cn/oidc`);
the API host, the profile read and token revocation are derived from it. Keep the application type
as a standard web app with a client secret sent in the request body (`client_secret_post`) and
allow the password and verification-code (SMS and email) sign-in methods and the password reset
by SMS and email code, with the sign-up
(auto-register) and SMS/email login templates enabled in the Authing console; it needs no callback
or logout redirect URL.
Authing sees every sign-in from the Web server's address, so the Web server limits attempts itself
before calling it: in 15 minutes 20 per client address, 10 per email or phone number from one
address, and 50 per email or phone number from all addresses together (an address refused at its
own limits is not counted against the account, so one address cannot lock an account out); and,
for sending a code, in an hour 20 per client address and 10 per phone number or email. Every
count is in Redis, keyed by a hash of the destination or account (and of the address, for the
pair); with no Redis nothing is limited. The client address is the
last `X-Forwarded-For` hop, the one Caddy appends, and is passed to Authing as `options.clientIp`.
Computer CLI login is a separate Device Flow client and is unchanged.

`/login` also offers "Continue with GitHub", off unless `COFORGE_GITHUB_SIGN_IN_CLIENT_ID` and
`AUTHING_GITHUB_CONNECTION` are both set (both environments set them in their compose files). The
browser stays on CoForge's domain: `/auth/github` sends it to GitHub's authorize page with
`<origin>/auth/github/callback` as the redirect URI and a random `state` held in a short-lived
signed cookie, and the callback has Authing exchange the returned code (`signin-by-mobile`, through
the connection `AUTHING_GITHUB_CONNECTION`), then signs in like any other method; a first GitHub
sign-in goes to the name step. The client id is that of the GitHub OAuth app `CoForge` in the
`lrm-lab` organization, shared by staging and production; the connection is the Authing "GitHub
Mobile" connection `github-mobile` in both user pools. The app registers two kinds of callback
URL (verified live 2026-10-27): `https://coforge.cn/auth/github/callback` and
`https://staging.coforge.cn/auth/github/callback`, where the browser returns, and each pool's
`https://core.authing.cn/connection/social/github-mobile/<pool id>/callback`, which Authing
presents when it exchanges the code at GitHub (GitHub refuses the exchange without it). Its
client secret lives in the Authing console, never here. These settings are not the `COFORGE_GITHUB_*`
GitHub App integration's. `COFORGE_GITHUB_SIGN_IN_AUTHORIZE_URL` (default GitHub's authorize page)
exists only so the browser e2e can stand in for GitHub; a deployment leaves it unset.

For local UI work without Authing, uncomment `COFORGE_DEV_SKIP_AUTH=1` in
`apps/web/.env`. This returns a fixed dev user on the server and is ignored when
`NODE_ENV=production`. Remove or disable it before validating real login flows. The dev user
needs a row in the database (`bun run seed:dev` creates it with a name). A dev user with a
row and no name is asked for one at the first-sign-in name page like anyone else, and that
works; with no row at all there is nothing to save a name on, and pages fail until it is seeded.

Web Push uses one stable VAPID P-256 key pair. Set the URL-safe base64 public
key in `COFORGE_WEB_PUSH_PUBLIC_KEY`, put the matching private key in a local
untracked file with mode `0600`, and set its path in
`COFORGE_WEB_PUSH_PRIVATE_KEY_FILE`. Keep
`COFORGE_WEB_PUSH_SUBJECT=https://coforge.cn`. Never put the private key itself
in `.env`, source, logs, or browser configuration. All backend replicas for an
environment must use the same pair; changing it requires browsers to
resubscribe.

Local Web UI and Web/backend are the same TanStack Start package. Compile
once, then start the production Nitro processes. Neither script uses port 3000.

```bash
mise install
mise run setup
./scripts/build-prod.sh      # protocol generate + vite/nitro production build
./scripts/start-web.sh       # http://127.0.0.1:8788 (compiled Nitro)
./scripts/start-server.sh    # http://127.0.0.1:8789 (compiled Nitro)
```

`./scripts/dev-frontend.sh` and `./scripts/dev-backend.sh` are aliases for
`start-web` / `start-server`. They require a prior `build-prod` and no longer
auto-compile. For Vite HMR while iterating on UI (and for
`COFORGE_DEV_SKIP_AUTH`), use `./scripts/dev-web-hmr.sh` instead.

The scripts find the mise Bun install if `bun` is not on PATH. Re-running a
script replaces whatever is already listening on that port.
The server a `start-web`, `start-server` or `dev-web-hmr` script started stops
with it (`scripts/supervised-bun.ts`): a stop or Ctrl-C is passed on to it, and
if the script is killed outright the server notices within half a second and
stops itself. A server still running 10 seconds after being asked to stop is
killed. A closed terminal ends the script, and the server follows it; under
`nohup` both keep running (give `dev-web-hmr` `< /dev/null` too: Vite exits when
its stdin ends). Ctrl-C is passed on even when the script runs as a background
job that would otherwise ignore it (`sh -c './scripts/start-server.sh &'`).
However the server is sent SIGTERM (by its script, a script replacing it on its
port, or `kill`), it is killed if it is still running 10 seconds later. Under
`bun run dev:hmr` (or `dev:backend`, `dev:frontend`) the script runs below a
`bun run` process; killing only that process leaves the script and its server
running, so stop the process group (`kill -- -<pgid>`) or run the `scripts/*.sh`
script directly. `bun run --cwd apps/web local-servers list` shows what is
running, and `local-servers stop --stale` stops servers whose checkout is gone
or that listen on no port with no launcher waiting for them. It counts only
this package's servers, and from a deleted checkout only those started through
a launcher above; when `lsof` shows no listening socket on the machine at all,
it stops nothing.

Edit `src/routes/index.tsx` to get started. Add route files under
`src/routes`; TanStack Router updates `src/routeTree.gen.ts` for you.

Run this package's short checks and production build with:

```bash
bun run --cwd apps/web test
bun run --cwd apps/web check
bun run --cwd apps/web build
```

Production local serving uses `./scripts/build-prod.sh` then `start-web` /
`start-server`. Vite HMR remains available via `./scripts/dev-web-hmr.sh`.
Docker is reserved for production builds and container verification. The
production server uses Nitro's Bun preset:

```bash
docker build -f apps/web/Dockerfile -t coforge-web .
docker run --rm -p 3000:3000 coforge-web
```

The pinned Nitro 3 adapter is currently beta and its production behavior must
remain covered by build, startup, health, and graceful-shutdown checks before a
release is promoted.

Add official components from this package directory using the
[Untitled UI CLI](https://www.untitledui.com/react/docs/cli):

```bash
npx untitledui@latest add button
```
