# ScreenTinker — architectural invariants

Rules that cannot be inferred from reading any single file, and that erode quietly when they are not
written down. If a change appears to require breaking one of these, **stop and raise it** — it is not
a judgement call to make inside a PR.

Each invariant names the test that holds it up. A reviewer should be able to check the rule is still
guarded without reading the implementation, and a PR that deletes a guard should be as visible as one
that deletes a feature.

> Detailed reasoning lives in [`docs/mesh-directive.md`](docs/mesh-directive.md).
> The design that implements these is [`docs/mesh-phase0-design.md`](docs/mesh-phase0-design.md).

---

## Node mesh (2.0)

Every ScreenTinker instance is a **node**. Player, site server, hub, proxy, analytics sink are not
types — they are one node declaring different **capabilities**, connected by **edges**.

| # | Invariant | Guarded by |
|---|---|---|
| **I1** | **Autonomy.** A node is fully functional with no parent. A parent is an observer, never a dependency. Mesh is off by default and invisible. | `test_mesh_off_by_default` |
| **I2** | **Upward-only in 2.0.** Telemetry flows up. The child implements **no downward command handler at all** — a parent emitting one hits the floor. | `test_no_downward_command_handler` |
| **I3** | **No cycles.** Edges form a DAG (multi-parent is permitted). Refusal is a reachability check at enroll time, not a path-prefix check. | `test_cycle_refused_by_reachability_not_prefix` |
| **I4** | **Identity is position-independent.** Node UUID generated locally at first boot. Re-parenting changes display paths only. | `test_node_id_encodes_no_position` |
| **I5** | **Opaque relay.** An intermediate node forwards payloads it cannot parse, unmodified. It may read the envelope only. | `test_unknown_payload_is_relayed_not_dropped` |
| **I6** | **Failure isolation.** One child — unreachable, flooding, ancient, skewed — never stalls a sweep, blocks a dashboard, or throws into a shared handler. | `THE ISOLATION PROPERTY`, `THE I6 CASE`, `a dead child stops being attempted` |
| **I7** | **No phone home.** Pairing codes and UUIDs minted locally. No licence check, no activation, no beacon, no registry. Air-gapped is first-class. | `test_no_phone_home` |
| **I8** | **Cloud is a peer.** screentinker.com is a node with no special privileges. | ⏳ Phase 1 (topology harness) |
| **I9** | **No built-in relay address, no automatic relay fallback.** Relay is a capability at an operator-supplied address. A failed direct connection never silently reroutes. | `test_no_builtin_relay_address`, `test_no_automatic_relay_fallback` |
| **I10** | **Enforcement lives with the data owner.** The node that owns data enforces its grant — never the requesting node. Connection direction is irrelevant. | `test_grant_defaults_to_denied` |

All in `server/test/mesh-invariants.test.js`.

**Hub-side access** is a separate concern with its own guards in `server/test/mesh-client-roles.test.js`
and `server/test/mesh-client-tree.test.js`:

- A client is invisible until someone is explicitly named on it, **or inherits it from an ancestor**.
- **Inherited access may never be silent.** Resolution always carries provenance (`direct` /
  `inherited via X` / `platform-admin`), and `whoGainsAccess` discloses who will gain access *before*
  a client is nested. This is the one place default-deny-by-absence is deliberately bent, and the
  disclosure is what makes it acceptable.
- An unrecognised role grants nothing and **stops the walk** — skipping it would hand the user the
  broader inherited role and turn a typo into an escalation.
- **No role may imply downward control.** A "full access" role would promise a capability I2 says
  does not exist.

⏳ **I8 is stated but still not guarded.** "Cloud is a peer" needs a test that stands up a hosted-
shaped node and a self-hosted one and shows the relationship works identically in both directions —
which the topology harness can now express but nothing yet asserts. It is the last unguarded
invariant, and it is recorded here rather than quietly assumed.

**I6 became testable once transport landed**, as predicted, and is now guarded three ways: a flooding
child does not starve a quiet sibling (per-child backpressure), a dead child is skipped rather than
waited on (circuit breaker), and a malformed payload from a remote writer cannot throw into the
shared socket handler. `server/test/mesh-backpressure.test.js`, `mesh-topology.test.js`,
`mesh-aggregation.test.js`.

### Why several guards are source-level, not behavioural

For an invariant whose value is **absence**, absence is the thing to test. A behavioural test can only
show that a downward command handler did not fire in the cases someone thought to try; asserting that
no such handler exists in `server/lib/mesh/` proves there is nothing to fire. Same for the relay
address: the risk is not that today's code calls a vendor host, it is that a future "sensible default"
gets added during an outage. A source assertion is what catches that in review.

### The uptime report

`server/lib/mesh/uptime-report.js` produces the per-client artifact, and three of its rules exist
because the obvious implementation is confidently wrong rather than obviously broken:

- **Fleet uptime is device-weighted, never wall-clock-merged.** Merging overlapping incidents is right
  *within* a device (two rules, one outage) and catastrophic *across* one — a single dead screen
  unions with the whole estate and reports the client as 0%.
- **The denominator is time observed, not time elapsed.** A screen installed mid-window is not scored
  as down before it existed (`mesh_mirror_devices.first_seen_at`), and a retired one stops counting
  when it was retired.
- **Silence is not success.** Incidents are the only evidence of downtime, so a site whose link died a
  week ago sends none and scores 100% — a broken collector producing a beautiful report. Unseen time
  is excluded from the numerator and surfaced as **coverage**, rendered beside uptime at the same
  size. `csvCell()` also neutralises spreadsheet formula injection, because screen names arrive from
  another server and land in a document the customer opens in Excel.

### The depth gate

`MESH_MAX_DEPTH` defaults to **2** and must not be raised in code. The machinery for deeper trees
exists and is tested — multi-hop relay, deep clock skew, subtree re-parenting, per-hop downsampling —
but two tiers have not yet run against real hardware, which is the condition the directive sets.
Guarded by `THE DEPTH CAP IS STILL 2` in `server/test/mesh-depth.test.js`.

**Aggregate fidelity, specified rather than emergent:** alerts and current state are full fidelity at
any depth; historical telemetry thins per hop with the resolution carried alongside the data;
proof-of-play is never thinned, and is on a refuse-list rather than relying on a grant property
somebody has to remember to set — averaged evidence is not evidence, and the failure is silent until
an invoice is disputed.

### Explicitly not in 2.0

Downward commands, content push, cross-node writes of any kind, automatic topology discovery,
rendezvous/hole-punching for both-sides-NAT, a built-in relay address, automatic relay fallback.
**No stubs, no dormant paths, no disabled-in-UI versions.** Write grant categories and the
`redistributes-content` capability exist *in the vocabulary* and are refused by validation — that is
so a stored edge stays valid when Phase 5 lands, and it is the one deliberate exception.

---

## Data collection

Established by the Phase −1 audit — [`docs/mesh-telemetry-inventory.md`](docs/mesh-telemetry-inventory.md).

- **Telemetry must not assert what it cannot know.** Unknown is `null`, never a plausible default.
  The web player sent `battery_charging: false` for months, meaning "unknown", which made it the only
  field populated on 100% of rows while `battery_level` sat at 36%. Guarded by
  `server/test/telemetry-honesty.test.js`.
- **A field nothing reads is not free.** It is a privacy liability under a client's security review, a
  bandwidth cost multiplied by mesh depth, and a row in a grant vocabulary someone must justify.
- **Public/WAN address is separable from LAN address** in the grant vocabulary. It is populated for
  every production device and it locates a client's premises.
- **Wi-Fi SSID is being dropped** and must not return, including as a grant category. 94% of its
  production values were not SSIDs; the remainder were geolocatable customer network names.
