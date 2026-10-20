# @coforge/eval-harness

The eval computer the collaborative benchmarks share: `startEvalDaemon` registers one eval
Computer for a benchmark Workspace, starts an in-process Daemon for it, and gives the hosted Agents
their runtime config; `startAgent` starts one Agent the way the product does, attaching a memory
fence to its AgentStart intent when the benchmark asks for one.

Each benchmark passes its short label (`lme`, `sb`, `pcm`), which names the eval Computer and its
daemon state directory (`evalHostIdentity`), and the Agents it hosts.

It imports the Daemon and the SDK by package name, but still drives Web internals (and one
`@coforge/agent` runner constant its entry does not export) by relative import, rather than through
public interfaces.
