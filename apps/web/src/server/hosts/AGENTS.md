# Cloud cluster

These rules apply to `src/server/hosts/`.

- One deployment controls one Swarm cluster. `COFORGE_CLOUD_CLUSTER_TOKEN` is the shared secret; only its hash is stored. When the variable is unset or too short, cloud computers are refused.
- `HostDirectory` creates that one cluster row, binds the runtime's node key once, and stores the latest `accepting` flag from its heartbeat. There is no user enrollment and no online-host list.
- Register, heartbeat, claim, and report authenticate with the cluster token. A user session is not a cluster token.
- A cloud Computer belongs to the user account. `HostJobs` keeps one live default, which cannot be deleted, and at most one live extra in each Workspace. That Workspace's extra slot stays taken until the cluster reports the service gone.
- Completing first sign-in starts the account's default cloud computer for the personal Workspace. Creating another Workspace does the same. The Computers page runs the same ensure again. Joining another workspace attaches that workspace to the existing computer. It does not create another container.
- Formatting a cloud computer queues a delete that removes the service and its volume, then places the same computer again. The typed name must match the name the owner sees. It does not delete the computer row. After the new container is reported, other linked Workspaces are attached again.
- Claim order is delete, then attach, then create. A cluster that is not accepting skips create and still claims delete and attach.
- The daemon key is returned only when the cluster claims a create or attach, and it is cleared when the job is reported. Browser and list APIs never return it.
- `host-production.server.ts` wires the database and the token. Routes stay thin adapters over it.
- Operator steps for a new deployment are in `docs/operations/cloud-swarm/README.md`.
