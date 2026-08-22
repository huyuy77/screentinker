# Triggers

**Status: approved design, not built.** Externally-fired events that put interrupt content over a
running playlist, resolved entirely on the device.

## Why

An AV integrator: *"the player receives a REST JSON message or a UDP message and it starts playing
another playlist… a configuration interface that sets the triggers and the corresponding playlist,
and whether playback plays once or loops until the trigger is cleared."*

⚠️ **It must work with the WAN down. That is the entire feature.** Nothing in the fire path may
depend on reaching the hub — not to resolve a token, not to fetch content, not to log. A trigger
that needs the internet is a trigger that fails on the day the internet is why you needed it.

The gear that fires these is Crestron, Extron and PLCs. That equipment emits a one-line raw socket
send. It will not do TLS, auth headers, or JSON bodies. The wire format is designed for what that
hardware can actually emit, not for what is pleasant to specify.

---

## What already exists, and what that decided

Three findings from the existing code shaped this more than any preference did.

**`pipShow(p)` / `pipClear(id)` (`server/player/index.html`) are already the single render path.** The
`device:pip-show` / `device:pip-clear` socket handlers are three-line wrappers around them. So the
trigger path calls the same functions. Nothing forks per transport, nothing duplicates the overlay
renderer, and there is no hub round trip to remove because there never was one.

**`pruneToPlaylist(urls)` (`server/player/sw.js`) deletes any content-cache entry not in the playlist
URL set.** A trigger target is therefore not merely un-prefetched, it is *actively evicted* unless it
joins that set. Pinning is not a new subsystem; it is appending to the existing `st-cache-playlist`
message.

**`showZoneItem(zone, div, items, index)` is already a scoped, multi-instance rotation engine.** It
takes its own container and item list, keys its timer, handles widget/youtube/video/image, honours
per-item schedules, and advances on duration or video-end. A multi-zone layout runs several of them
at once. The overlay is one more instance.

---

## Decisions, and what each one prevents

### 1. The target is a PLAYLIST, not a URL

This reversed during design, and the cache policy is why. `isCacheableContent()` only matches library
content, so an arbitrary `http://…` target **cannot be pinned** — it would be fetched live, which is
exactly the WAN-down guarantee failing at the only moment it matters.

Playlist items are already library content. They already flow through the prefetch chain and are
already protected from the prune. Pinning becomes: resolve `target_ref` → playlist → item URLs,
append to `st-cache-playlist`. No policy change, no warning, no asterisk.

```sql
target_kind TEXT NOT NULL DEFAULT 'playlist',   -- v1: 'playlist'; later: 'url'
target_ref  TEXT,                               -- v1: the playlist id
target_url  TEXT                                -- v1: NULL
```

`'url'` becomes the later addition, gated on the cache-policy question, and it inherits the warning.
The shape is unchanged either way, so adding it needs no migration and no backfill.

⚠️ **Consequence:** trigger playlists join the device's cache working set and compete for the same
quota as the base playlist — on a BrightSign widget that is a real budget. The UI shows combined
pinned size per device, because the alternative is a mysterious eviction.

### 2. The wire carries a TOKEN, never content

One line, ASCII, ≤512 bytes:

```
ST1 <secret> <token>
```

`ST1` is magic+version. Subnet broadcast means the socket sees every stray datagram on the LAN, so
rejecting on a 4-byte compare before parsing keeps that cheap and keeps the reject counters
meaningful. It also gives a version hook without renegotiation.

The HTTP path accepts `{"secret":…,"token":…}` **or** the same raw line as `text/plain`, because some
gear can only POST a string.

⚠️ **This is the core security property, not a convenience.** The wire never carries a URL, a
duration or a position. An attacker who guesses a token can only display content an operator already
configured for that screen.

Clear uses the same format: a per-trigger `clear_token`, plus a device-level clear-all. One format,
one parser, one handler; token resolution decides fire vs clear.

### 3. One socket, three addressing modes

`dgram`, `udp4`, `reuseAddr`, bound `0.0.0.0:PORT`. That single bind receives unicast and subnet
broadcast inherently. Multicast is the *same socket* plus `addMembership(group, ifaceAddr)` — not a
second code path. Default group `239.255.42.1`, port `7847`, outbound TTL 1.

**Rejoin is what decides whether this works in the field.** Interface polling alone misses the common
failure: a switch doing IGMP snooping stops forwarding the group when it misses a membership report,
and nothing on the host looks wrong. So:

- unconditional re-`addMembership` every 90s (errors swallowed; re-adding is harmless) — this is the
  backstop that fixes the silent case by emitting a fresh IGMP report;
- an `os.networkInterfaces()` watch that drops and rejoins on address change — the fast path for
  DHCP renewal, link flap and wake.

Both transports converge on `handleTrigger({token, secret, source, sourceIp})`.

### 4. Reuse `showZoneItem`, with one refactor

The overlay is an instance of the existing rotation engine rendering into a div inside
`#pipContainer` with a synthetic `{id:'__trigger__'}`. Per-item scheduling inside a trigger playlist
comes free.

⚠️ It needs one change: `showZoneItem` writes `zoneTimers[zone.id]`, and `renderZones()` calls
`clearZoneTimers()` which wipes the whole map — so **a layout change landing mid-interrupt would
silently kill the overlay's advance timer and freeze it on one item.** Fix is a default parameter,
`showZoneItem(zone, div, items, index, timers = zoneTimers)`, with the trigger passing its own store.
One argument, backward-compatible, and it removes a cross-talk bug rather than routing around it.

### 5. `once` plays the playlist through; `max_duration_sec` is a cap

`once` = play the trigger playlist through once, then hide.

The field is **`max_duration_sec`**, deliberately not `duration_sec`. The PiP contract already uses
`duration` where `0` means *until cleared*; here `0` means *no cap*. Two adjacent fields where the
same value means opposite things is a trap, so the name differs because the semantics differ. It also
sits correctly beside `lease_sec`.

If the playlist is longer than the cap, **the cap wins and the overlay hides mid-playlist.** The cap
exists so a misconfigured trigger cannot hold a screen indefinitely; honouring the playlist instead
would make the safety valve advisory. Logged as `[trigger] once capped at Ns (playlist needs Ms)`.

The sum of item durations is known at save time, so the UI validates it and warns in the editor. An
installer finds out while configuring, not at 3am.

### 6. `until_cleared` gets an optional LEASE

⚠️ **A clear is a single unacked datagram.** If it drops, or the sender dies mid-alarm, the screen is
stuck with no path back except someone driving to the site.

Senders already re-assert on a timer (§8) — so that re-assertion becomes load-bearing. Optional
`lease_sec` on `until_cleared` triggers:

- each matching re-fire **renews** the lease;
- expiry with no renewal auto-clears, logged `[trigger] lease expired, auto-cleared`;
- explicit clear still works and stays the fast path — the lease is a backstop, not the mechanism;
- **unset means hold indefinitely**, which is today's behaviour, so this is opt-in.

The same re-fire that §8 makes a playback no-op is the liveness signal here. One mechanism, two jobs:
the chatty sender stops being a nuisance and becomes the thing that proves the alarm is still real.

⚠️ **A held-but-preempted trigger's lease still ticks.** The assertion is about the world, not about
the screen. A lease that expired while preempted must be dropped from the held set, or it pops back
when the higher-priority overlay clears — reasserting a condition that has already lapsed.

**What the UI does about UDP-without-lease.** That is the stuck-screen configuration, so it is called
out where it is created and where it is diagnosed:

- the trigger editor **prefills `lease_sec = 90` for new triggers with UDP enabled**, clearable. The
  stored semantic is unchanged — unset still means indefinite — but the safe value is the one you
  have to remove rather than the one you have to find;
- clearing it shows an inline warning naming the actual failure: *"if the clear datagram is lost this
  screen holds the overlay until someone clears it by hand"*;
- it is **not blocked.** An operator with a reliable HTTP clear path, or who genuinely wants an
  indefinite hold, has a legitimate configuration;
- device diagnostics show it as a standing condition, not only at save time — a trigger written
  before this existed, or assigned to a new screen later, still surfaces where an installer looks;
- an active `until_cleared` overlay with no lease is flagged in the live view as *held indefinitely*.

### 7. Collisions: highest-priority-wins, with `until_cleared` held

Not an interrupt stack. A stack accumulates expired one-shots and needs eviction rules nobody gets
right; pure last-wins loses a still-valid condition.

Only `until_cleared` triggers are **held** when preempted — a `once` that was interrupted has had its
moment, and restoring it later shows stale content at the wrong time. On any clear, the
highest-priority still-held trigger re-renders.

Concretely: "room occupied" (p10) preempted by "evacuate" (p100); when evacuate clears, "room
occupied" returns, because nothing ever said it stopped being true. A p10 `once` promo does not.

Ties go to the last arrival, matching the existing last-show-wins semantics so the manual and
triggered paths behave identically. A lower priority arriving while a higher is active is dropped,
counted, and logged with both names.

### 8. A resumed trigger restarts at item 1 — but a re-fire does not restart

A held trigger is a *state assertion*, not a paused timeline. If "evacuate" was authored with the
exit map as item 1, resuming at item 4 makes the first three items unreachable for as long as the
preemption lasted. Resuming position also means per-trigger playback state surviving preemption —
state that leaks, and that nobody notices is wrong.

⚠️ **Re-firing a trigger that is already active is a no-op, not a restart.** Crestron and PLC gear
re-assert on a timer, and subnet broadcast produces duplicates anyway. If every repeat restarted the
overlay, a sender re-asserting every 5s would freeze a 6-item emergency loop on item 1 forever — and
it would look like the playlist was broken, not like the sender was chatty. A repeat renews the lease
(§6) and changes nothing else.

### 9. Decoder contention: detection is settled, policy is not

`videoCompositingAvailable()` already answers *"does this platform put video on a hardware plane"*
with a cached 16×16 alpha probe, verified on the XT245. With the existing `kind` computation:

```
mustPreempt = baseKind is video/youtube
           && overlayKind is video/youtube
           && !videoCompositingAvailable(currentVideoEl)
```

On preempt the base video element is torn down by the path `renderContent` already uses, the overlay
takes the plane, and **the base playlist's timeline keeps running** — only the decode is yielded. On
clear, `playCurrentItem()` (the existing #146 re-attach) resumes at whatever item the timeline
reached. No new resume machinery, no restore step.

⚠️ **The policy is not fixed until it is tested on an XT245**, for a specific reason: multi-zone
layouts *already* put several simultaneous `<video>` elements on screen and that path ships today. So
either the XT245 handles concurrent decodes — in which case compositing is right and preemption is
complexity for nothing — or multi-video zone layouts are already broken there and nobody has hit it.
Both are worth knowing. The detection is ready either way.

Also note `videoCompositingAvailable` literally answers "can a canvas read these pixels", a *proxy*
for the hardware plane. It is the right proxy on every platform we ship, but it is one.

### 10. Two flags, both default OFF

`TRIGGERS_ACCEPT_HTTP` and `TRIGGERS_ACCEPT_UDP`, following the `MESH_ACCEPT_ENROLLMENT` /
`MESH_ALLOW_UPLINK` convention — and the argument is stronger here than for the mesh.

HTTP is unicast TCP to one host; the blast radius is whoever can route to it. UDP multicast or
broadcast means **one datagram changes every screen in the building at once.** Those are different
risks. The Wi-Fi guidance (§12) makes HTTP-only a real deployment rather than a theoretical one, and
a single flag would force an operator who wants the safe transport to open the dangerous one.

For the player page, which env vars cannot reach, the flags are per-device settings pushed from the
hub and cached locally so they survive WAN loss. The on-device server honours the env equivalents.
Assigning a trigger to a screen whose listener is off warns rather than silently doing nothing.

### 11. Threat model: unauthenticated content injection on a LAN you do not control

- Flags off by default: a site that never sets them has no listener and no open port.
- Per-device shared secret required in every payload, rotatable per device.
- Token resolution is scoped to triggers **assigned to this screen** — a valid token for another
  screen does nothing here.
- Optional source-IP allowlist.
- Per-source token bucket. ⚠️ Reject *logging* is rate-limited to one line per window per reason,
  mirroring the `[content-ack] shedding` fix: a packet flood must not become a log flood.
- Bounded effect: the overlay layer only. No schedule mutation, no publish, no hub call, and no
  arbitrary URL from the wire.

**Residual, stated plainly:** UDP on a shared LAN is spoofable and the secret is cleartext on the
wire. The mitigation is deployment guidance — a dedicated AV VLAN — plus the fact that a successful
forgery shows the operator's own approved content. Better written down than implied to be
authentication.

### 12. Platforms

Capability is **probed, never inferred**: `require('dgram')`, bind, join, and only then declare.
That is the existing rule in `declaredCapabilities()` (*"a capability we cannot verify is left out"*)
and the same lesson as `read-runner.js` detecting worker_threads by trying. `trigger.http` and
`trigger.udp` become declared capabilities, so the UI shows per screen which transports work.

Browser players get neither and say so. On wireless devices multicast is unreliable by design: the UI
warns and recommends unicast HTTP, but does not disable UDP.

### 13. Observability: one number answers the site visit

`[trigger]` on every fire, accept and reject, into the existing `__debugLog_push` / `device:log` sink.

| field | why |
|---|---|
| `udp.group`, `udp.port`, `udp.iface_addr`, `joined_at`, `rejoin_count`, `last_join_error` | is membership actually held |
| **`last_datagram_at`** | **any** datagram, including rejected ones |
| `received` / `accepted` / `rejected{bad_magic,bad_secret,unknown_token,not_assigned,rate_limited}` | which half of the path failed |
| `active_overlay{trigger, mode, since, source, source_ip, lease_expires_at}` | what is on screen and why |

⚠️ **`last_datagram_at` counting rejected traffic is the whole point.** Recent timestamp with zero
accepts means multicast *is* reaching the player and the token or secret is wrong. Null timestamp
means nothing is arriving and it is the network. Those are different site visits, and telling them
apart is the single most valuable diagnostic in this feature.

Plus a **loopback self-test**: the player sends one datagram to its own group and reports whether it
received it — proving socket and membership without involving the integrator's gear at all.

---

## Data model

```sql
triggers (
  id, workspace_id, name,
  match_token, clear_token,
  source_http INTEGER DEFAULT 1, source_udp INTEGER DEFAULT 0,
  target_kind TEXT DEFAULT 'playlist', target_ref TEXT, target_url TEXT,
  position, width, height, opacity, border_radius,   -- reuses the PiP contract verbatim
  mode TEXT,                      -- once | until_cleared
  max_duration_sec INTEGER,       -- once: upper bound; 0/unset = no cap
  lease_sec INTEGER,              -- until_cleared: renew-or-expire; unset = indefinite
  priority INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
  created_at, updated_at )

trigger_assignments (trigger_id, target_type TEXT /* device|group */, target_id)
```

Tenancy is `workspace_id`, this codebase's unit — `pip.js` scopes every query by `req.workspaceId`,
so isolation comes free from the existing helpers rather than from new checks.

Definitions ride the existing `device:playlist-update` payload as top-level `data.triggers`, beside
`layout` / `group_sync` / `timezone`, with their own signature comparison mirroring `layoutSig`.
⚠️ They must **not** enter the item fingerprint, or every trigger edit restarts playback (#234).
Persisted via `saveTriggersCache()` → localStorage, mirroring `saveLayoutCache`, and loaded at boot
before the socket connects: triggers work on a cold boot with the WAN down, or they do not work.

---

## Risks

**The listener changes what is on a screen, from the LAN, unauthenticated by the standards of the
transport.** §10 and §11 are the answer, and the flags defaulting off are the part that matters most.

**Multicast membership loss is silent.** §3's periodic rejoin is a treatment, not a cure — a switch
that never forwards the group at all looks identical from the host. §13's `last_datagram_at` is what
makes that diagnosable rather than a guess.

**A stuck `until_cleared` overlay is the worst failure this feature can produce**, because it is a
screen showing the wrong thing with the base playlist invisible behind it. §6's lease is the backstop
and §6's UI rules are how an operator avoids configuring the failure in the first place.

**Trigger playlists compete for the cache quota** (§1). Silent eviction would present as a trigger
that fires and shows nothing.

---

## Order of work

1. Schema, entity CRUD, assignment to screens and groups.
2. `showZoneItem` timers default parameter — on its own, with the cross-talk bug covered by a test.
3. Sync to device, local persistence, pinning into `st-cache-playlist`.
4. The single internal handler + HTTP transport, behind its flag.
5. UDP transport on one socket, membership and rejoin, behind its flag.
6. Priority, held set, lease, and the collision rules.
7. Observability counters, the capability probe, and the loopback self-test.
8. The XT245 concurrent-decode test, then §9's preempt policy.

⚠️ Step 8 is listed last but **runs first** — the answer can change step 6's rendering, and it is the
one open question that is a design decision rather than an implementation detail.
