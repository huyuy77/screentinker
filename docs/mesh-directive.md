# ScreenTinker — Node Mesh: Full Directive

Supersedes `screentinker-enterprise-directive.md` Track B and `screentinker-mesh-directive.md`.
Track A (scheduled screenshots, threshold alerts, bulk enrollment, README truth pass) is unchanged
and still lands first — A2 is a hard prerequisite for Phase 3.

**All mesh work on one long-lived branch** (`2.0.0`). Each phase is a PR into that branch. The branch
merges to main once Phase 4 is green. Global constraints from the Track A directive (no prod deploys,
`bump-version.sh`, standalone version-bump commits, changelog per release, full PR bodies, player
parity, tests as part of the work) apply throughout.

---

## Concept

Every ScreenTinker instance is a **node**. A node may accept enrollments from below and may enroll
upward. A player is a node with no children. A site server is a node with players below and possibly
a parent. A hub is a node with sites below. A proxy relays for its subtree. An analytics sink consumes
and relays nothing. These are not separate types — they are one node declaring different
**capabilities**, connected by **edges**.

#288 already proved a node can be server and player at once. This makes that the rule.

---

## Feature flags

Mesh is **off by default and invisible** on every existing install. Two independent flags, because
accepting observation and becoming an observer are different risks:

| Flag | Default | Effect |
|---|---|---|
| `MESH_ACCEPT_ENROLLMENT` | `0` | This node may mint pairing codes and accept child enrollments. Required to act as hub/proxy/relay/sink. |
| `MESH_ALLOW_UPLINK` | `0` | This node may enroll upward to a parent. |
| `MESH_MAX_DEPTH` | `2` | Runtime depth cap. Raised only in Phase 4. |
| `MESH_MIN_NODE_VERSION` | _(set in Phase 0)_ | Oldest node version this node will accept an edge from. |

With both flags off: no new UI, no new routes, no new background work, no schema behavior change.
A user who never sets them must not be able to tell the mesh exists.

---

## Hard invariants

Violating any of these is stop-and-raise, not a judgement call. All of them go in `ARCHITECTURE.md`
with a named test each (`test_no_downward_command_handler`, `test_no_builtin_relay_address`, …), because
none are inferable from reading a single file, and there are outside contributors and bot PRs landing.

**I1 — Autonomy.** A node is fully functional with no parent. Scheduling, playback, local alerting,
player management, local dashboard: unchanged standalone. A parent is an observer, never a dependency.

**I2 — Upward-only in 2.0.** Telemetry, health, alerts flow up. The child implements **no downward
command handler at all** — a parent emitting one hits the floor. Tolerance ("ignore what you don't
understand") is forward-compat and does NOT enforce this; the absence of a handler does.

**I3 — No cycles.** Edges form a DAG (multi-parent is permitted — see Phase 0). Cycle refusal is a
reachability check at enroll time, not a path-prefix check, and not a runtime check.

**I4 — Identity is position-independent.** Node UUID generated locally at first boot. Mirrored rows
carry origin node UUID, never a path. Re-parenting changes display paths only.

**I5 — Opaque relay.** An intermediate node forwards payloads it cannot parse, unmodified. It may
read the envelope only.

**I6 — Failure isolation.** One child — unreachable, flooding, ancient, skewed — never stalls a sweep,
blocks a dashboard, or throws into a shared handler. Extends #146 one tier up.

**I7 — No phone home.** Pairing codes minted locally. UUIDs generated locally. No license check, no
activation, no usage beacon, no central registry. Air-gapped is first-class.

**I8 — Cloud is a peer.** screentinker.com is a node with no special privileges. A self-hosted hub
with hosted sites below must work exactly as well as the reverse.

**I9 — No built-in relay address and no automatic relay fallback.** Relay is a capability any node
may declare at an operator-supplied address. There is never a compiled-in host, and a failed direct
connection never silently reroutes. (This is how a peer architecture quietly becomes hub-and-spoke,
and it always arrives as a bug fix.)

**I10 — Enforcement lives with the data owner.** The node that owns data enforces its grant. Never
the requesting node. Connection direction is irrelevant to this.

---

## Phase −1 — Telemetry inventory (do this first, it is small)

Before shipping anything upward, audit what is collected and why. Collecting unused fields is a
privacy liability, a bandwidth cost multiplied by tree depth, and a thing a client's security review
will ask about.

Produce a table of every telemetry field the players and server collect — battery, storage, RAM, CPU,
Wi-Fi signal, Wi-Fi SSID, uptime, LAN and WAN address, event-loop lag, widget telemetry, error and
crash telemetry, proof-of-play — with, for each: who writes it, who reads it, is it surfaced in UI, is
it alertable after A2, and is it correct.

Then decide per field: **consume** (wire it to something), **keep** (justified, document why), or
**drop** (stop collecting). Known suspect: battery reporting has been flagged as wrong or absent —
confirm and either fix or drop it. Anything landing in "drop" should be removed before Phase 2, not
mirrored upward.

Output is a short document plus whatever removal PRs fall out. It also becomes the source for the
data-category grant vocabulary in Phase 0.

> **Status: complete.** See [`mesh-telemetry-inventory.md`](mesh-telemetry-inventory.md).

---

## Phase 0 — Design PR (schema and interfaces, no behavior)

This is the review gate. Everything downstream inherits these decisions.

### Node identity
- v4 UUID generated locally at first boot, stable across restarts and re-parenting.
- **Duplicate-UUID detection.** Cloned VMs are routine in MSP work. If the same origin UUID arrives
  over two edges, refuse the second and flag it loudly. Silent interleaving corrupts history in a way
  that is near-impossible to untangle later.
- **Node identity ≠ device identity.** A self-hosting node (#288) declares the association explicitly
  so it does not double-count in rollups.

### Edges as a table, not a parent pointer
A node has N edges. `parent_id` on the node is forbidden — it forecloses multi-parent, which the MSP
case needs (your hub observes a client's server; the client's own hub also observes it) and hub
migration needs temporarily. Each edge carries:

| Attribute | Notes |
|---|---|
| `role_capabilities` | **Set, not enum.** e.g. `accepts-enrollment`, `relays-for-subtree`, `redistributes-content`, `consumes-proof-of-play`. A new node type must be a new capability combination, never a schema change or a branch in pairing logic. |
| `grant` | See below. Separate from role — a hub edge and a proxy edge with the same grant are different machines. |
| `transport_direction` | Which side dials. A reachability property only. Never implies anything about grant. |
| `retention` | Per edge. The parent may hold longer or shorter than the origin. |
| `tombstone_purge` | Per edge, not a fixed 30 days — must be able to respect a client whose own retention is shorter. |
| `tls_verify` | On by default; explicit per-edge opt-out for self-signed (on-prem, BrightSign). Visible in UI, not buried in config. |
| `min_version` / negotiated capabilities | From handshake. |

### Grants: data categories, not read/write
This is what a client's security review will actually ask about. "Read" today would mean device names,
LAN and WAN addresses, content metadata, possibly screenshots — client-owned data landing in an MSP's
database. The vocabulary must let a client grant **health only, no content metadata, no screenshots**.

- Build the full vocabulary now (drawn from the Phase −1 inventory); implement only read categories
  in 2.0. Write categories exist in the model and are rejected until Phase 5.
- Default every category to denied. Write requires affirmative selection with the consequence in plain
  language on the granting node: *"this hub will be able to change what plays on your screens."*
- Enforced at the source (I10). A denied category is never sent, not filtered on arrival.
- Consequence to surface: a health-only grant makes that client's devices un-searchable by name. The
  empty state must say so, or it reads as a bug.

### Envelope and payload contracts
- Envelope: origin node UUID, ancestry at send time, **origin timestamp** (origin's clock), **receipt
  timestamp** stamped per hop. Never order events by a single clock. Detect and surface node clock
  skew rather than silently reordering the alert inbox.
- Mirrored types (node health, device summary, alert event, proof-of-play) are **explicitly versioned
  contracts**, so bodies evolve while the envelope stays stable. Otherwise a hub upgrade breaks every
  older child at once.
- **Version policy, decided now:** minimum accepted node version, deprecation window, and how skew is
  surfaced to the operator. Player compatibility stays maximal — that promise is unchanged. Node
  compatibility is a different contract: a node is a participant that writes into someone's database,
  and setup is five minutes, so "reasonably current" is a fair ask. Without a stated floor you can
  never change the envelope.
- **Refusal is explicit.** A node asked for a capability it cannot fulfil refuses with an
  operator-readable reason. Never accept-and-silently-degrade. The reason string is designed, not
  incidental.

### Tombstones
Deleting a device on a child does not vanish it from the parent — last month's uptime report must not
change retroactively. Tombstone with `deleted_at`, purge per edge policy.

### Hub-side permissions
The six existing roles are workspace-scoped. An MSP tech should see Acme and not Contoso — that is
scoping by node or client, which is not a workspace. Add a **client** grouping primitive above node
(an MSP thinks in clients; a client may own three servers). Decide the model here; it is a schema
question and "everyone at the MSP sees every client" will not survive a security review.

### Migration
Every existing install becomes a node with zero edges. No-op migration, no behavior change, no new UI
unless someone pairs something. This is the guarantee that Phase 0 cannot break anyone on 1.9.x.

---

## Phase 1 — Pairing and transport (depth capped at 2)

Reuse the server↔player relationship, promoted. Do not write a second transport — that one has been
through #146, #148, mass-reconnect payload cost, and `COMMAND_QUEUE_TTL_MS` flush-on-reconnect.

**Pairing is one flow with a declared role, identical in feel to adding a screen:**
1. Node A mints a short-lived single-use pairing code (CSPRNG, #26 precedent).
2. Operator enters A's URL + code on node B, choosing role capabilities and grant.
3. B contacts A: node UUID, version, capability set, ancestry.
4. A validates — code unburned, no cycle, depth within cap, version above floor — and returns a
   durable edge token scoped to B's own subtree.
5. Code burns. Token expires with renewal, revocable from either end. Define how a revocation at hop
   two reaches a leaf at hop four.

**Transport direction is negotiated per edge.** Whoever types the URL is not necessarily who dials.
Dial-out solves NAT wherever one side is reachable — which is the case that matters, since the
reachable node is always operator-owned. Both-sides-NAT is **out of scope**: no rendezvous, no STUN,
no TURN. Documented as an accepted limitation precisely because it is what a future contributor would
"solve" with a central relay.

**Backpressure.** A child is an authenticated remote writer running a version you do not control.
Payload caps, ingest rate limits, bounded per-child storage — the July unbounded-widget-telemetry
lesson, except remote. A flooding child is throttled and flagged, not accepted.

**Disenrollment.** From either side. Mirrored data retained-and-marked-stale by default with an
explicit purge. A node losing its parent reverts to standalone silently and buffers for backfill.

**Consent visible from below.** The child's own dashboard shows: linked to this parent, exactly what
it can see, when it last synced, and a revoke button. An MSP link the client cannot see or sever is a
contract dispute waiting to happen — and visibility is what makes a client comfortable agreeing.

> **Status: complete** — but it was marked complete once before it was, and that is worth recording.
>
> ⚠️ **Every module existed, was tested, and NOTHING CALLED THEM.** No route minted a pairing code,
> none redeemed one, and no production code ever constructed an `Uplink`. Two servers could not be
> connected by any means an operator has. Unit tests all passed, because each piece worked in
> isolation — which is exactly how a phase gets marked done while the feature does not exist. Now:
> `routes/mesh-enroll.js` (mint / redeem / enrol / sever) and `services/mesh-uplink.js`.
>
> Four further defects only an end-to-end run could surface, all of them invisible to the unit tests:
>
> 1. **`token_expires_at` was never SELECTed** by the auth query, so `edgeIsActive()` read `undefined`
>    and the expiry check silently never ran — an expired edge token authenticated forever.
> 2. **Authorisation was snapshotted at handshake.** Mesh sockets are long-lived by design, so
>    revoking an edge did nothing until the child happened to reconnect. Re-checked per envelope now.
> 3. **The pairing code was stored in its display form** and looked up normalised, so every redemption
>    answered "that code is not valid" about a code minted seconds earlier.
> 4. **`MESH_MIN_NODE_VERSION` was a dead knob**, and the floor `2.0.0` refuses `2.0.0-alpha0` —
>    a prerelease sorts below its own release, so every alpha node refused every other alpha node.
>    The floor is `2.0.0-0`.
>
> Original status: Pairing (`pairing.js`), revocation/disenrollment + consent-from-below
> (`edge-status.js`), per-child backpressure (`backpressure.js`), node identity and edge storage
> (`store.js`), and **transport** — parent side `ws/meshSocket.js` on its own `/mesh` namespace,
> child side `uplink.js` dialling out with jittered backoff and a bounded buffer. The topology
> harness (`test/helpers/mesh-topology.js`) covers the graph and failure injection;
> `test/mesh-transport.test.js` covers the real wire.
>
> ⚠️ Still open: **half-open sockets**. socket.io's ping/pong covers the common case, but a
> deliberately half-open peer is not yet simulated in CI — it needs a raw TCP fixture, and asserting
> it without one would be theatre.

### Topology test harness — a Phase 1 deliverable, not optional
Spin N nodes in CI, assemble arbitrary graphs, and simulate: parent unreachable, half-open socket,
child flood, version skew, clock skew, mid-sync disenroll, re-parent, cycle attempt, duplicate UUID.
Every later phase adds cases. Distributed bugs do not reproduce on demand — without this you are
debugging through Discord reports about topologies you cannot see, and that is what makes or breaks
this staying maintainable by one person.

---

## Phase 2 — Upward aggregation

> **Status.** Landed: grant-filtered projections at the source (`mirror.js`), backfill priority
> (`backfill.js`), per-child circuit breaker (`circuit-breaker.js`), cross-node alert rollup
> (`alert-rollup.js`). Opaque relay was proven in Phase 1 over the real wire.
>
> Storage landed too: `mirror-store.js` over four tables (`mesh_mirror_nodes`, `_devices`, `_alerts`,
> `_play_logs`), with per-edge retention, tombstones, and purge-on-request. Every row carries BOTH
> the origin's timestamp and ours, which is what makes Phase 3's tri-state possible.

- Telemetry, health, version, reachability mirrored upward, filtered by grant at the source.
- Opaque relay implemented and tested with a deliberately unknown payload type.
- Per-child circuit breaker, jittered backoff (#144 precedent).
- **Backfill priority: current state → open alerts → history trickling.** A node with 400 screens and
  months of history must not thunder-herd the ingest path on first pair. Useful within seconds,
  complete within hours.
- **Cross-node alert dedup.** A fleet-wide condition produces one rolled-up alert on the hub, not N
  node-level ones. Reuses the A2 dedup and once-per-outage semantics rather than a parallel path.

---

## Phase 3 — Hub UI *(requires Track A2 merged)*

> **Status: complete.** A2 is merged. Landed: tri-state status, client-scoped read-only hub API
> (`routes/mesh.js`), presentation logic (`lib/mesh/hub-view.js`), the **Servers** section
> (`frontend/js/views/servers.js`) as four tabs — screens, alert inbox, topology, uptime report —
> with server-side search and pagination, per-node rollup, deep links, and the exportable per-client
> uptime report (`lib/mesh/uptime-report.js`, CSV).
>
> Three defects were found while finishing it, all of the same shape — code that ran, returned, and
> was wrong in the reassuring direction:
>
> 1. **`/uptime` was not scoped.** It checked the caller could see one node, then reported over every
>    `alert_events` row on the server. A technician named on one client got every client's incident
>    history. Now the client is resolved and authorised before a row is read.
> 2. **`openAlerts: 0` was hardcoded** in the node rollup, so a site with nine open alerts rendered a
>    clean card. A placeholder that renders as a *reassuring* value is worse than a missing one.
> 3. **`alert-rollup.js` had no caller.** It was written in Phase 2, tested, and never wired in — so
>    the inbox would have shown forty sites down rather than "suspect this hub's own connection".
>    Wiring it exposed a units mismatch (ms window vs second timestamps) that would have silently
>    disabled correlation entirely.

### Information architecture
- **New top-level section: Servers.** Nodes, proxies, relays, sinks live here. Players stay exactly
  where they are today.
- **Remote workspaces do NOT enter the workspace switcher.** The switcher mints a JWT with
  `current_workspace_id` and reloads — it assumes a local, writable workspace. Putting remote ones
  behind it means every write surface (bulk assign, drag-to-group, playlist assign, schedule editor)
  grows a disabled state, and a UI full of dead controls teaches people the product is broken.
  Instead: read-only browse of remote workspaces inside Servers, plus one aggregated cross-node
  screens view grouped by client and node.
- Remote devices appear under their org/workspace with origin node as **its own column and a badge** —
  not string-concatenated into the name, which breaks sort and search.
- Deep-link from any remote row into that object on its origin node's dashboard. This is what keeps
  the hub read-only and still useful.

### Status is tri-state, never binary
- **Green** — online, freshly reported.
- **Amber/grey** — *stale*: origin node unreachable, showing last known state as of a timestamp.
- **Red** — confirmed offline, reported by a node currently reachable.

A WAN blip on a hub link must never paint 400 healthy screens red. Every remote row shows its as-of
time; a green dot from 90 minutes ago is a lie by omission.

### Time
Store UTC, carry origin timezone on the row, and let the **view** choose the bucket, labeled on screen:
- **Operator-local for live views** — "offline since 3pm" should mean 3pm to the reader.
- **Origin-local for reports and per-device history** — a store manager's downtime happened during
  *their* business hours. Bucketing Perth's October by Kenosha days makes every uptime number subtly
  wrong with no visible cause. This is the same call already made correctly for schedules in July.

### Other Phase 3 requirements
- Search hits the hub's mirror (fast, bounded by grant), carrying the same staleness as everything
  else. **Server-side pagination and search from the start** — fine at 40 devices, fatal at 10,000.
- Per-node rollup: screens online vs total, version spread, active alerts.
- Cross-node alert inbox.
- Topology view: the graph, depth, per-edge health, version skew.
- **Per-client uptime report** — "your 40 screens were up 99.2%, here are the three incidents,"
  exportable. This is the artifact MSPs actually pay for, and it is downstream of A2's alert history.

---

## Batching (designed, not built)

The report cycle sends one envelope per device — 402 messages for a 400-screen child, every 60
seconds. Measured, batching beats per-message compression by 17× on a cycle and 92× on backfill, and
costs less CPU. It is also the difference between a reconnecting child draining its buffer in seconds
and being throttle-bound for ~83 of them.

See **`docs/mesh-batching-design.md`**. The decisions that make it a protocol change rather than a
tuning knob: capability negotiation (an older parent would relay-and-not-store a batch *silently*),
per-item attestation and per-item outcomes (I6 — one bad payload costs one bad payload), item-count
backpressure (or batching becomes a way around the rate limit), and alerts staying unbatched because
latency is the point of an alert.

---

## Phase 4 — Depth unlock

> **Status: built, NOT unlocked.** Multi-hop relay, deep skew, subtree re-parenting and aggregate
> fidelity (`lib/mesh/fidelity.js`) are implemented and tested at depth 4.
>
> ⚠️ **`MESH_MAX_DEPTH` still defaults to 2, deliberately.** The gate is this document's own: *raise
> it only after two-tier has run against real hardware*. Nothing has been deployed, so an operator
> raises it knowingly. A test asserts the default has not drifted — the easiest way to lose a gate
> like this is for somebody to bump a constant while making a deep test pass.

Raise `MESH_MAX_DEPTH` only after two-tier has run against real hardware. Multi-hop relay, deep skew,
subtree re-parenting, aggregate fidelity.

**Aggregate fidelity is the known hard problem** — per-sample data does not survive many hops, which is
exactly where Prometheus federation disappoints people. Specify it, do not let it emerge: alerts and
current state stay full fidelity at any depth; historical telemetry downsamples per hop with the
sampling interval visible in the UI. Allow a **no-downsample grant property** for consumers that need
raw data (proof-of-play is worthless averaged), documented as costing bandwidth proportional to depth.

---

## Phase 5 — Content distribution *(post-2.0, separate review series)*

The first thing that flows **downhill**, and the actual scaling payoff.

- **Caching relay:** a node caches media for its subtree, so 400 screens at one site produce one origin
  pull plus LAN distribution rather than 400 WAN pulls. Conceptually ContentCache and the web service
  worker promoted to infrastructure.
- **Inheritance with locking:** a parent playlist that children extend but cannot remove from — the
  corporate-to-local case (corporate spots plus compliance messaging on every store's screens, local
  additions allowed, inherited items locked and read-only from below). Note this is *inheritance*, not
  nested playlists: one level, clear ownership, no recursion, and unlike generic nesting it can
  actually enforce that a local site does not drop the safety message.
- **Parent-owned content must be marked and locked on the child.** Otherwise a local admin edits an
  inherited item, the next sync clobbers it, and they have silently lost work — the worst class of bug,
  because nobody notices for a week.

Because this inverts I2's direction, it gets its own security review and its own PR series. **No stubs
for it in Phases 0–4.**

---

## Security

- Edge tokens encrypted at rest, never logged, redacted in activity logs and error surfaces.
- Enroll, disenroll, token rotation, grant change, and depth-cap change all land in the activity log on
  **both** nodes.
- A child may attest only to its own subtree. Reject any payload claiming an origin outside the sending
  child's subtree — a compromised leaf must not forge peer data.
- Enrolling an edge is a `platform_admin` action on both ends.
- Hub retention per edge must be visible to the client from their side. Holding data past a client's
  own retention policy is a real problem in regulated environments.

---

## Explicitly not in 2.0

Downward commands, content push, cross-node playlists or scheduling, cross-node writes of any kind,
automatic topology discovery, rendezvous or hole-punching for both-sides-NAT, built-in relay address,
automatic relay fallback. No stubs, no dormant paths, no disabled-in-UI versions.
