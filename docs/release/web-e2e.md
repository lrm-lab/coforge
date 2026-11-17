# Web browser e2e

The scheduled browser e2e workflow (`.github/workflows/web-e2e.yml`) runs the browser e2es
(`apps/web/test/*.e2e.ts`) listed in `scripts/e2e/web-e2e-ci.txt`, daily at 19:47 UTC and on
demand. It blocks nothing and publishes nothing. Any listed file that fails turns the run red;
there are no retries.

Each of the two shards runs `scripts/e2e/run-web-e2e-ci.sh <shard> 2`: it builds the Web, runs
the migrations, both dev seeds (`seed-dev-data.ts`, then the full `seed-dev.ts`, which many files
depend on), starts a Centrifugo container on the host network so its proxies reach the Web, serves
the Web on `127.0.0.1:8788` behind a front door on `127.0.0.1:8790`
(`scripts/e2e/same-origin-proxy.ts`: `/connection/*` to Centrifugo, the rest to the Web, one
origin as in production, so a page's realtime connects; the files open the front door) and runs
its share of the list one file per `bun test` process.
PostgreSQL and Redis are service containers. All three images are the ones staging runs, by
digest (`scripts/ci/web-integration-images.test.ts`).

The shards are balanced by the seconds recorded beside each file in the list. The run page's
summary has a table per shard (file, result, seconds). A failed shard uploads
`web-e2e-shard-<n>` for a week: each file's output, the Web's, Centrifugo's and the front door's
logs, and the screenshots the tests wrote under `.amp/e2e/`.

## What is on the list

Admission to the scheduled list requires three consecutive clean runs on a private stack,
followed by a clean run on the Linux runner. Temporary scheduling budgets must be explicitly
annotated and replaced by measured runtime after the first successful CI run.

Every `.e2e.ts` under `apps/web/test` must be registered exactly once: either in
`scripts/e2e/web-e2e-ci.txt` with the seconds used to balance shards, or in
`scripts/e2e/web-e2e-ci-excluded.txt` with a non-empty reason. The exclusion file does not run
anything; it makes the files omitted from the scheduled suite visible. Existing unregistered
files are initially marked `待分拣` for a separate triage task. New files must be registered in
the same change that adds them.

`scripts/ci/web-e2e-list.test.ts` checks complete coverage, file existence, unique registration
and exclusion reasons. It also refuses included files that drive `ego-browser`, which operates
a signed-in desktop browser and cannot run on a CI runner. When moving a file into the CI list,
remove its exclusion entry and record its measured runtime. Files needing capabilities the CI
stack does not provide stay excluded with the specific reason.

Two things differ between a local run and the runner:

- The sign-in e2es (`e2e-sign-in-harness.ts`: `e2e-first-sign-in-*`, `e2e-sign-in-flow`, and the
  others that use it) build the Web again, into the same `apps/web/.output` a running Web serves.
  On the runner both come from one checkout, so nothing changes. Locally, a Web started from an
  older build then asks for asset files that are gone, and every later page stays on "Loading
  messages…": build and restart the Web after the checkout moves.
- The runner's Chrome has no mouse (`hover: none`), so the app takes its touch layout: a click on
  a message's words opens its action sheet. A file that passes on a Mac can fail there for that
  reason alone; drive a Linux Chrome over CDP (`agent-browser --cdp <port>`) to see it locally.

Run one shard locally, against a PostgreSQL and Redis on the default ports, with
`CENTRIFUGO_IMAGE` set and agent-browser installed:

```sh
CENTRIFUGO_IMAGE=centrifugo/centrifugo:v6.9.2 scripts/e2e/run-web-e2e-ci.sh 1 2
```

`scripts/e2e/run-web-e2e-ci.sh 1 2 --list` prints a shard's files without starting anything.
