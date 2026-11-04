# Web browser e2e

The scheduled browser e2e workflow (`.github/workflows/web-e2e.yml`) runs the browser e2es
(`apps/web/test/*.e2e.ts`) listed in `scripts/e2e/web-e2e-ci.txt`, daily at 19:47 UTC and on
demand. It blocks nothing and publishes nothing. Any listed file that fails turns the run red;
there are no retries.

Each of the two shards runs `scripts/e2e/run-web-e2e-ci.sh <shard> 2`: it builds the Web, runs
the migrations, both dev seeds (`seed-dev-data.ts`, then the full `seed-dev.ts`, which many files
depend on), starts a Centrifugo container on the host network so its proxies reach the Web, serves
the Web on `127.0.0.1:8788` and runs its share of the list one file per `bun test` process.
PostgreSQL and Redis are service containers. All three images are the ones staging runs, by
digest (`scripts/ci/web-integration-images.test.ts`).

The shards are balanced by the seconds recorded beside each file in the list. The run page's
summary has a table per shard (file, result, seconds). A failed shard uploads
`web-e2e-shard-<n>` for a week: each file's output, the Web's and Centrifugo's logs, and the
screenshots the tests wrote under `.amp/e2e/`.

## What is on the list

A file goes on the list after it passes three clean runs in a row on a private stack built the
same way. `scripts/ci/web-e2e-list.test.ts` checks that every listed file exists, and that none
drives `ego-browser`, which operates a signed-in desktop browser and cannot run on a CI runner.
Files that need something the run does not provide stay off it: a database reset
(`e2e-agent-direct-message`, `e2e-agent-introduction`), OIDC (`e2e-oidc-*`), a provider key
(`e2e-openrouter-live`), a managed environment (`agent-control`, `kiro-native`). Files that fail
for other reasons are tracked in their own task until they are fixed and added.

Run one shard locally, against a PostgreSQL and Redis on the default ports, with
`CENTRIFUGO_IMAGE` set and agent-browser installed:

```sh
CENTRIFUGO_IMAGE=centrifugo/centrifugo:v6.9.2 scripts/e2e/run-web-e2e-ci.sh 1 2
```

`scripts/e2e/run-web-e2e-ci.sh 1 2 --list` prints a shard's files without starting anything.
