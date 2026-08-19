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
| **I6** | **Failure isolation.** One child — unreachable, flooding, ancient, skewed — never stalls a sweep, blocks a dashboard, or throws into a shared handler. | ⏳ Phase 1 (topology harness) |
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

⏳ **I6 and I8 are stated but not yet guarded.** They are properties of transport, which does not
exist until Phase 1 — there is nothing to assert against today, and a test that passes because the
code is absent is worse than no test, because it reads as coverage. The Phase 1 topology harness
(spin N nodes, assemble arbitrary graphs, simulate failures) is where both become testable, and it is
a Phase 1 *deliverable*, not an optional extra.

### Why several guards are source-level, not behavioural

For an invariant whose value is **absence**, absence is the thing to test. A behavioural test can only
show that a downward command handler did not fire in the cases someone thought to try; asserting that
no such handler exists in `server/lib/mesh/` proves there is nothing to fire. Same for the relay
address: the risk is not that today's code calls a vendor host, it is that a future "sensible default"
gets added during an outage. A source assertion is what catches that in review.

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
