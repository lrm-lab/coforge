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

Browser login uses Authing as the hosted OpenID Connect IdP. Copy
`apps/web/.env.example` to `apps/web/.env` and set `AUTHING_APP_SECRET` plus a
random `COFORGE_SESSION_SECRET` of at least 32 characters. Do not commit the
secret. In the Authing console, register the callback URL
`http://localhost:8788/auth/callback` exactly, and the logout redirect URL
`http://localhost:8788/`. Keep the application type as a standard web app,
and use authorization-code mode. Computer CLI login is a separate Device Flow
client and is unchanged. Each deployed environment must likewise allow its
public origin with a trailing slash as a logout redirect URL, such as
`https://staging.coforge.cn/` or `https://coforge.cn/`.

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
