# Phase −1 — Telemetry inventory

Input to [`mesh-directive.md`](mesh-directive.md) Phase 0. Every field the players and server collect,
what it is for, and whether it survives into 2.0.

**Why this comes first.** A field that nothing reads is three problems at once: a privacy liability
under a client's security review, a bandwidth cost multiplied by tree depth, and a row in a grant
vocabulary that has to be explained to someone. Anything marked **drop** is removed *before* Phase 2,
so it is never mirrored upward in the first place.

**Method.** Population percentages are measured against the live production database
(248,314 `device_telemetry` rows, 292 reporting devices, 509 devices total, sampled 2026-08-19).
Read-side counts are from the source. Nothing here is inferred from a schema alone — a column that
exists and is always NULL reads identically to one that works, until you count.

⚠️ **Low population means "new" or "dead", and the two are opposite conclusions.** `video_mode` sits at
0.7% and `temperature_c` at 0.0%; the first shipped nine days ago for BrightSign and is working, the
second has been collected for months and has never once been written. Date the column before judging it.

---

## Device telemetry (`device_telemetry`, sampled per heartbeat)

| Field | Populated | Written by | Read by | In UI | Alertable (A2) | Correct? | Verdict |
|---|---|---|---|---|---|---|---|
| `uptime_seconds` | 100% | all players | server, UI | yes | yes | yes | **keep** |
| `battery_level` | 36.4% | Android only | server, UI | yes | candidate | yes, where reported | **keep** (platform-limited) |
| `battery_charging` | 100% | all players | server only | **no** | no | **no — fabricated** | **fix, then keep** |
| `storage_free_mb` / `storage_total_mb` | 38.9% | Android, BrightSign | server, UI | yes | yes | yes | **keep** |
| `ram_free_mb` / `ram_total_mb` | 37.1% | Android, BrightSign | server, UI | yes | candidate | yes | **keep** |
| `cpu_usage` | 37.1% | Android, BrightSign | server, UI | yes | candidate | yes, over-precise | **keep, round** |
| `wifi_rssi` | 36.4% | Android | server, UI | yes | candidate | yes | **keep** |
| `wifi_ssid` | 97.5% | all players | server, UI | yes | no | **no — 94% is not an SSID** | **drop** |
| `local_ip` | 20.6% | players | server, UI | yes | no | yes | **keep** |
| `local_ip6` | 4.6% | BrightSign | server, UI | yes | no | yes | **keep** |
| `temperature_c` | **0.0%** | nobody | — | declared | no | never written | **drop** |
| `attached_display` | 0.002% | BrightSign only | server, UI | yes | no | yes — new 2026-08-10 | **keep** |
| `video_mode` | 0.7% | BrightSign only | server, UI | yes | no | yes — new 2026-08-10 | **keep** |

### `wifi_ssid` — drop

Every distinct value in production, by frequency:

| Value | Rows | Is it an SSID? |
|---|---|---|
| `Web Player` | 151,713 | no — a literal string the web player sends |
| `permission` | 41,060 | no — Android's location-permission refusal, stored verbatim |
| `<unknown ssid>` | 34,894 | no — Android's own placeholder |
| *(null)* | 6,111 | — |
| 5 real network names | 14,536 | **yes — and that is the problem** |

Two independent reasons, either sufficient:

1. **94% of it is not an SSID.** `server/player/index.html:2327` sends the literal `'Web Player'`, so
   the column has become a de-facto "what kind of player is this", which `devices.client_type` already
   records properly. The field is misnamed for what it actually holds.
2. **The 6% that IS real is the liability.** Those are customer network names — `Verizon_VKC37F`,
   `RealEstate5167788777`. Wi-Fi SSIDs are geolocatable against public wardriving databases, so this
   is a field that can place a client's premises on a map. It is exactly what a security review asks
   about, it is surfaced in the UI, nothing alerts on it, and no feature needs it.

Dropping it also removes a whole grant category from the Phase 0 vocabulary rather than having to
justify one.

### `battery_charging` — fabricated, fix before Phase 2

`server/player/index.html:2316-2317`:

```js
battery_level: null,        // honest: the web has no battery API
battery_charging: false,    // ⚠️ claims "not charging" when it means "unknown"
```

Hence 100% population against 36.4% for `battery_level`: every web player asserts `false`. It reads as
data and is not, no UI displays it, and mirroring it upward would spread a fabricated value across a
fleet. Fix is one word — `false` → `null` — after which population should track `battery_level`, and
that becomes the regression test.

This is the "battery reporting has been flagged as wrong or absent" suspicion in the directive, and the
answer is *both, in different places*: **absent** on web (correctly — no API), **wrong** on web
(`charging` fabricated), **correct** on Android (100% populated on every Android platform measured).

### `cpu_usage` — keep, but round

Stored at full float precision: `34.700234234333`, 87,297 distinct values across 248k rows. Nobody
displays more than a whole percent. Rounding at the source costs nothing and is bandwidth saved on
every hop — the exact cost the directive says to multiply by tree depth before shipping.

---

## Other collected surfaces

| Surface | Volume | Purpose | Verdict |
|---|---|---|---|
| `play_logs` | 1,294,987 | proof-of-play | **keep** — ⚠️ Phase 4 `no-downsample`; averaged proof-of-play is worthless |
| `event_loop_lag` | 259,127 | server self-health (#240) | **keep**, node-local; a mesh should carry a summary, not samples |
| `device_events` | 1,085 | display on/off, connectivity cause | **keep** |
| `device_status_log` | 438 | online/offline with reason | **keep** — the uptime report in Phase 3 is built on it |
| `device_usage_daily` | 613 | per-day rollup | **keep** |
| `device_fingerprints` | 395 | hardware identity | **keep**, node-local — never mirror; it is how a device is re-identified locally |
| `player_debug_logs` | 106 | opt-in live debug | **keep**, node-local, already opt-in |
| `telemetry_reports` | 8 | install statistics collector | **keep** — separate opt-in system, not part of the mesh |

### `devices.ip_address` — a grant category, not a drop

Populated for **509 of 509** devices, and the values are **public WAN addresses** (`109.250.…`,
`171.76.…`, `80.51.…`, `2401:49…`), not LAN ones. It is legitimately used for reachability and
support, so it stays — but it identifies where a client's premises are, and under the directive it
must be its own grant category so a client can grant health without granting location. A "health only"
grant that still ships the public IP of every screen would not survive the review the directive is
written for.

---

## Falling out of this

1. **Drop `wifi_ssid`** — stop collecting, remove from the UI, retire the column.
2. **Fix `battery_charging`** — `false` → `null` on web, with a test that population tracks
   `battery_level`.
3. **Drop `temperature_c`** — never written by anything, in any player, since it was added.
4. **Round `cpu_usage`** at the source.

Items 1 and 3 are removals and must land before Phase 2. Item 2 is a correctness fix worth taking
regardless of the mesh.

## Grant vocabulary this implies (input to Phase 0)

Grouped so a client can grant one and deny the next:

- **health** — uptime, storage, RAM, CPU, battery, Wi-Fi signal strength
- **identity** — device name, hardware model, serial, app version
- **network** — LAN address, **public/WAN address** (separable; see above)
- **display** — attached display, video mode, orientation, screenshots
- **content-metadata** — playlist and content names, schedules
- **proof-of-play** — play logs (⚠️ no-downsample)
- **diagnostics** — device events, status log, debug logs

`wifi_ssid` would have been an eighth category. Dropping it removes the need for one.
