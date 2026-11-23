# Cloud environment model

| Concern            | `staging`                                        | `production`                                        |
| ------------------ | ------------------------------------------------ | --------------------------------------------------- |
| Trigger            | Operator dispatch from `main`                    | Coordinator dispatch from `main` with a tested digest               |
| Authorization      | Operator dispatch under staging release checks                   | Coordinator verifies the exact digest, CI and Web integration       |
| Artifact           | Newly built immutable digest                     | Same digest already healthy in `staging`            |
| GitHub Environment | `staging`                                        | `production`                                        |
| Compose project    | `coforge-staging`                                | `coforge-production`                                |
| Concurrency        | One deployment at a time                         | One deployment at a time                            |
| Rollback target    | Previous healthy digest or empty bootstrap state | Previous healthy digest or approved bootstrap state |

GitHub Environment secrets, variables, protection, deployment history, and
concurrency are independent from the Git branch model. Staging and production
must use separate secrets, databases, volumes, networks, internal ports, and
public endpoints when both environments exist.

Every Compose invocation must pass the intended project explicitly with `-p`;
do not derive it from a checkout directory. Render and validate the effective
base-plus-environment configuration before mutation. Environment secrets must
not be committed, echoed, placed in command arguments, or copied into release
records.

Neither GitHub Environment enforces a required reviewer: `production` is
protected only by its branch policy, so deployments come from `main`, and
`staging` carries no protection rules. The release coordinator follows the
[routine release boundary](routine-release-boundary.md) before dispatch and
records the verification in `#release`.
