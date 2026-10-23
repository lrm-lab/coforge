# Presence events

`agent.status_changed`, `computer.online` and `computer.offline` tell an app that an Agent or a
Computer came or went. Their state is a Redis lease (the 90 s status keys), not a PostgreSQL row,
so unlike every other event they are not recorded in a domain transaction. Code:
`apps/web/src/server/app-notifications/` (`app-notification-presence`, `presence-sweep`,
`presence-expiry`, `presence-observer`), `RedisAgentStatusCache.put`, `RedisComputerStatusCache.put`.
The approved design is Frank's of 2026-10-23.

## Events

| Event | Fires when | `data` |
| --- | --- | --- |
| `agent.status_changed` | an accepted status put changes the status field, or the lease lapses (`active` to `inactive`) | `agent_id`, `from`, `to`, `observed_at` |
| `computer.online` | a put says online and the key was not `online` | `computer_id`, `from`, `to`, `observed_at` |
| `computer.offline` | a put says offline over `online`, or the lease lapses | `computer_id`, `from`, `to`, `observed_at` |

An absent status reads as `inactive` (Agent) or `offline` (Computer), as every status read does, so
the first `active` is `inactive` to `active`, and `inactive` or `offline` over nothing is no event.
Heartbeats, a repeated put and a put the ordering rule rejects never fire. There is no debounce. The
event's `timestamp` is `observed_at`: the Daemon's observation time for a put, Redis's clock for a
Computer put, the lease's end for a lapse.

## Mechanism

- **Transitions.** The status caches write through one Lua script that also returns the previous
  value, so the change is detected atomically with the write; a retried RPC finds the new value and
  fires nothing. They report it to a `PresenceObserver`; `AppNotificationPresence` builds the event
  and sends it with `AppNotifications.recordDetached` (the same flag check and queue as `record`,
  sent on the queue's own connection). The RPC never awaits it.
- **Silent expiry.** Redis tells nobody when a key lapses. While events are possible the same script
  files each active Agent and online Computer in a sorted set, `coforge:presence-expiry:v1` (score:
  the millisecond the lease ends, member: the status key), and removes inactive and offline ones.
  `PresenceSweep` ticks every 5 s on one instance (its own lock, `coforge:presence:expiry-sweep:lock`),
  takes at most 200 members whose score has passed by Redis's own clock (`TIME`, never the web
  instance's), and claims each with one script: a key that still exists is not emitted and its
  score moves to the key's real end (`PTTL`), so it cannot starve the batch; for a gone key `ZREM`
  must remove the member, so two instances racing emit once. A lapse is emitted however late, with
  its true expiry time as `observed_at`, so every online has its offline: after a long outage (the
  server down, the feature off) late offline and inactive events arrive, and an app reads the
  event's time, not its arrival.
- **Event ids** are UUIDv5 of the transition (Agent: Workspace, Agent, status, `clientSeq`, Daemon
  instance; Computer: Workspace, Computer, state, a per-Computer transition counter (a Redis key
  with a seven-day lease, incremented in the put script) and Redis time in ms, so two transitions
  cannot share an id; lapse: the status key and the score), so recording one twice is recording it
  once.

## Guarantees

Best effort, like Agent Activity: nothing is durable between the Redis write and the queue. An event
is lost if the queue is not running, the send fails, the server stops after the put, or Redis loses
the index; nothing replays it (`app_notifications:record_skipped` is logged for the first two). The
index is rebuildable and non-authoritative: losing it loses only the events of the leases it held.
A claim comes before the emit (that is what makes two instances emit once), so a crash between
them loses that expiry event. A Computer that goes offline does not make its Agents' leases lapse sooner; each lapses on its own.

## Cost while the feature is off

While `appNotificationsPossible()` is false (the flag file does not define `app-notifications`;
production's default) both puts are the commands they always were: no extra Redis write, no Workspace
lookup, no queue send, and a sweep tick returns before any Redis call (its connection is opened at
the first tick that runs); the Agent put script is byte-for-byte the one it always was (a test pins
it). The cost is per process, not per Workspace: while the flag is defined anywhere, every put in
every Workspace takes the tracked path and the sorted set holds the fleet's active Agents and online
Computers, and the Workspace's slug is read (cached for a minute) before the per-Workspace flag is
evaluated. The status caches report to the observer the composition root sets
(`registerBackgroundSweeps`); before that, or in a process that never composes, it is a no-op. The scripts assume one
Redis, not a cluster, as the existing status scripts do.

## Tests

`app-notification-presence.test.ts` (transition tables, the off path, `recordDetached`)
and `app-notification-presence.integration.ts` (a real Redis,
`APP_PRESENCE_TEST_REDIS_URL`; the previous value of every ordering case, the index, two sweeps
racing, a refreshed lease, a stale score moved to the key's PTTL, a skewed web clock, unique
Computer ids, a one-second lease that really lapses); `app-notification-presence-sweep.test.ts`
(the sweep with fakes, the observer holder, the flag-off script pin).
