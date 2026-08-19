# Phase 0 — design: schema and interfaces

Schema and interfaces only. **No behavior**: with `MESH_ACCEPT_ENROLLMENT` and `MESH_ALLOW_UPLINK`
both off — the defaults — nothing in this phase reads a table, opens a socket, or draws a pixel.

This is the review gate. Everything downstream inherits these decisions, so the ones that were *close*
are called out at the bottom rather than buried.

---

## What landed

| Area | Where |
|---|---|
| Invariants + named guards | [`ARCHITECTURE.md`](../ARCHITECTURE.md) |
| Grant vocabulary | `server/lib/mesh/grants.js` |
| Role capabilities | `server/lib/mesh/capabilities.js` |
| Envelope + payload contracts | `server/lib/mesh/envelope.js` |
| Node identity + version floor | `server/lib/mesh/node-identity.js` |
| Per-client roles | `server/lib/mesh/client-roles.js` |
| Schema | `server/db/database.js` (migrations array) |
| Feature flags | `server/config.js` |
| Tests | `server/test/mesh-invariants.test.js` (20), `server/test/mesh-client-roles.test.js` (10) |

---

## Decisions

### Edges are a table. `parent_id` is forbidden.

A node has N edges. The alternative — a parent pointer on the node — forecloses multi-parent, and two
real cases need it:

- **MSP overlap.** Your hub observes a client's server *while* the client's own hub also observes it.
  Both are legitimate, simultaneous, and carry different grants.
- **Hub migration.** Moving a fleet between hubs needs both edges alive briefly, or the migration is a
  cutover with a gap.

Adding the second parent later would be a schema change under live data. Allowing it now costs one
table. `UNIQUE (peer_node_id, direction)` also gives duplicate-identity refusal at the storage layer,
so a cloned VM cannot open a second edge underneath the application check.

### Grants are data categories, not read/write

Nine read categories, each separately grantable and deniable. Two properties matter more than the
list:

- **Default denied, no wildcard.** A grant is an explicit list, so a category added in a future
  version cannot retroactively widen an edge agreed before it existed. There is no `*`.
- **Enforced at the source (I10).** A denied category is never sent — not sent-and-filtered.

Two splits came directly out of the Phase −1 audit and would not have been obvious from the schema:

- **`network-wan` is separate from `network-lan`.** `devices.ip_address` is populated for **509 of 509**
  production devices and holds *public* addresses, which locate a client's premises. A health-only
  grant that still shipped them would fail the review this vocabulary exists for.
- **`display-capture` is separate from `display`.** Knowing the video mode is not consent to see what
  is on the screen.

There is no `wifi-ssid` category, because that field is being dropped.

**Consequence that must reach the UI:** a health-only grant makes those devices **un-searchable by
name**. The empty state has to say so, or it reads as a bug and someone "fixes" it by widening the
grant.

### Write categories exist and are refused

`content-push` and `device-command` are in the vocabulary and rejected by validation. This is the one
deliberate exception to "no stubs, no dormant paths" (I2), and it is narrow: nothing can grant them,
so no code path consults them. What it buys is that an edge stored in 2.0 is still a valid edge when
Phase 5 lands, and an operator reading the model today is not surprised later by a permission that
appeared from nowhere.

### Capabilities are a set, not an enum

The test of this design: adding a node type must require **no schema change and no new branch in
pairing**. "Regional cache that also consumes proof-of-play but does not relay" is a different set,
not a new type.

Capability is **not** permission. `relays-for-subtree` says a node carries traffic; the grant says what
it may read. Conflating them is how "it relays for us" becomes "it can read everything it relays" —
which I5 exists to forbid.

### Envelope stable, body versioned, two clocks

The envelope is what a relay reads; the body is what an endpoint reads. Splitting them is what lets a
mid-tier node forward a payload type invented after it was installed. Collapse them and a hub upgrade
breaks every older child at once.

**Two clocks, never one.** `origin_ts` from the observing node, `receipts[]` appended per hop. Nodes
are other people's machines: a site server two hours ahead would silently interleave its alerts into
the middle of yesterday in a hub's inbox, with nothing on screen explaining why the story does not add
up. Carrying both lets skew be *detected and shown* (`skewIsNotable`, ≥10 min) instead of quietly
corrupting history. Receipts **append** — overwriting the first destroys the only evidence of where a
delay was introduced.

An **unknown payload type is not an error**; it returns `relayOnly`. So does a *known* type at a newer
body version, which is the subtler case: parsing it as if it were ours would silently misread it.

### Version floor: **2.0.0**

Not a conservative guess — no earlier build can speak mesh, because the protocol does not exist before
it. The reason to name it now is that *without* a stated floor the envelope can never change: every
future edit has to stay compatible with everything ever shipped, so it does not get edited.

⚠️ **This is a different promise from player compatibility**, which stays maximal and is unchanged. A
player is a screen on a wall nobody may touch for three years. A node is a participant that writes into
someone else's database and takes five minutes to stand up.

An unparseable version is **refused**, not waved through: a peer that cannot state its version cannot
be held to a contract, and "unknown" is what a broken or hostile peer reports.

### Clients — the grouping primitive above node

`mesh_clients` + `mesh_client_access`. **Not a workspace**: the six existing roles are workspace-scoped,
and a workspace lives *inside* one server, while a client may own three. "Every tech at the MSP sees
every client" is what you get without this table, and it does not survive a security review.

**Default deny by absence.** No row in `mesh_client_access` means no visibility, so a newly added
client is invisible until someone is named. The alternative — visible-unless-denied — silently exposes
every new client to every tech the moment it is added, which is the wrong direction for a mistake to
fail in.

### Per-client roles — `viewer` and `manager`

Taken while it was still a `CREATE TABLE` edit rather than a migration against live rows.

⚠️ **The obvious model is wrong for 2.0.** "Read-only on Acme, full on Contoso" sounds like a
read/write split, but a hub cannot write to a client's screens at all — I2 makes the mesh
upward-only and there is no downward command handler to authorise. A "full access" role would grant
a capability that does not exist, which is worse than no role: it reads as a promise the product does
not keep, and an operator would reasonably assume their tech can act on a screen when they cannot.

The axis that genuinely differs per client is control of the **relationship**:

| Role | May |
|---|---|
| `viewer` | see this client's mirrored data, bounded by what the client granted |
| `manager` | additionally change retention, rotate tokens, disenroll, and move nodes between clients |

A tech who can view Acme's screens is a very different risk from one who can sever Acme's edge — and
the second is what a client asks about when they ask who at the MSP can do what.

**A third role arrives with Phase 5 and is deliberately not modelled.** That is an asymmetry with
`grants.js`, which models its write categories and refuses them — and the difference is where the
value is negotiated. A grant is agreed between two nodes across a version boundary, so its vocabulary
must be stable or an edge stored today becomes unreadable later. A role is local to this hub's
database and is never sent anywhere, so adding an enum value later is purely additive. Pre-modelling
a role whose semantics cannot yet be pinned down would mean guessing, and the guess would be
load-bearing by the time anyone checked.

Everything unrecognised **fails closed**: an unknown role grants nothing rather than falling back to
`viewer`, because "lowest role" still means seeing a client's data. `platform_admin` resolves to
`manager` everywhere, which is honest rather than contained — the instance owner can grant themselves
any row anyway, and the property a client actually cares about is that an ordinary technician sees
only the clients they were named on.

### Tombstones

Deleting a device on a child must not vanish it from the parent: last month's uptime report cannot
change retroactively, or no report is citable. `deleted_at` plus a purge horizon that is **per edge**,
so a client whose own retention is shorter binds the parent to it.

### Migration is a no-op

Five empty tables. Note they are `CREATE TABLE`, which the migration loop deliberately does not count
as applied work — only `ADD COLUMN` does — so a healthy boot stays silent rather than announcing
migrations it did not perform. Guarded by the schema test.

---

## Judgement calls worth a second opinion

These were decided to keep Phase 0 moving. Each is cheap to change now and expensive after Phase 1.

1. **Client is a flat grouping, not a hierarchy.** A client owns edges; clients do not nest. An MSP
   with regional sub-organisations would want nesting, and adding it later is a schema change. Flat
   was chosen because nesting invites the same recursion problems the directive rejects for playlists
   in Phase 5, and no stated requirement needs it yet.
2. **`direction` on the edge is `up`/`down` and stored on both sides.** Slight redundancy — each node
   stores its own view of the same edge — but it means neither side has to derive its relationship
   from the other's table, which matters when they disagree after a partition.
3. **Skew threshold of 10 minutes** for "notable". A minute is transit noise; ten is a story that will
   not add up. Arbitrary within an order of magnitude.

---

## Not built here, on purpose

No pairing flow, no transport, no sync, no UI, no background sweep. Phase 0 is the shape; Phase 1 is
the first thing that moves. The topology test harness is a **Phase 1 deliverable** and is where I6 and
I8 finally become testable — they are stated in `ARCHITECTURE.md` today with no guard, and that gap is
recorded rather than papered over.
