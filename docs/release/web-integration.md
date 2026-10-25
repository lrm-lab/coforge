# Web integration

The scheduled Web integration workflow (`.github/workflows/web-integration.yml`) runs the suites CI cannot, because its jobs have no database
(`apps/web/test/*.integration*.ts`). It blocks nothing and publishes nothing, and a
red run is read from the run page, whose summary lists each failed test with its file and the order the files ran in. The service containers use the
images staging deploys, by digest; `scripts/ci/web-integration-images.test.ts` fails CI when
they drift from `infra/staging/docker-compose.yml`, and the same test compares the
Centrifugo channel namespaces set in the workflow with `infra/staging/centrifugo/config.yaml` (proxy settings left out). Preparation lives in
`scripts/test/prepare-web-integration.sh`, the same script a developer runs. Centrifugo is
configured through its environment, since a service container cannot mount the staging
config file. A failed scheduled run is announced only by GitHub itself: to whoever last
edited the cron line, and to anyone watching the repository's Actions. Nothing posts to
CoForge, because that would put an Agent credential in a repository secret, a security
decision that has not been made.
