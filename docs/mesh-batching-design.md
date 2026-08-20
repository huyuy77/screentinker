# The batched envelope

**Status: design, not built.** Numbers from `scripts/measure-mesh-payloads.js`, which anyone can
re-run.

## Why

A 400-screen child currently sends **402 separate envelopes every 60 seconds** — one per device,
plus workspaces and node health. Measured:

| fleet | msgs/cycle | raw | per-msg deflate | per-msg brotli | **batched brotli** |
|---|---|---|---|---|---|
| 5 | 7 | 3.4 KB | 2.1 KB (38%) | 1.9 KB (43%) | **551 B (84%)** |
| 40 | 42 | 23.2 KB | 14.3 KB (38%) | 13.1 KB (43%) | **1.3 KB (94%)** |
| 400 | 402 | 227.4 KB | 140.6 KB (38%) | 129.1 KB (43%) | **8.3 KB (96%)** |
| backfill (5,000 buffered) | 5,000 | 2,836 KB | 1,761 KB (38%) | — | **19 KB (99%)** |

Per-message compression manages 38–43% because each envelope is ~581 B of which **173 B is envelope
overhead**, and a compressor handed 400 bytes has no history to work from. Batching the same cycle
reaches 96%; on backfill, 99%.

It is also cheaper: 400 messages cost 11.1 ms of brotli or 6.7 ms of deflate, while the same payload
as one buffer costs **2.3 ms**. Smaller *and* faster, on the thread reads were just moved off.

**And the byte counts understate it.** `maxMessages` is 600 per 10-second window. A reconnecting
child flushes up to 5,000 buffered envelopes at once, so backfill is *throttle-bound*: ~83 seconds of
being refused and re-buffered before it drains. Batched, the same history is a handful of messages.

---

## The shape

A batch is a **new payload type inside the existing envelope**, not a new envelope version.

```jsonc
{
  "envelope_version": 1,
  "origin_node_id": "…",        // the batching node
  "origin_ts": 1787200000000,   // when the BATCH was assembled
  "type": "batch",
  "body_version": 1,
  "ancestry": ["…"],
  "receipts": [ /* … per hop, as today */ ],
  "body": {
    "items": [
      { "type": "device-summary", "body_version": 1, "origin_ts": 1787199998000, "body": { … } },
      { "type": "device-summary", "body_version": 1, "origin_ts": 1787199998000, "body": { … } },
      { "type": "tombstone",      "body_version": 1, "origin_ts": 1787199999000, "body": { … } }
    ]
  }
}
```

**Transport metadata belongs to the batch; observation metadata belongs to the item.** Receipts
answer "where did the delay happen", which is a property of the journey — one chain for the batch is
correct and one chain per item would be 400 copies of the same answer. But `origin_ts` is when a
thing was *observed*, which differs per item and is what clock-skew detection reads, so it stays on
the item.

---

## Decisions, and what each one prevents

### 1. A new payload type, gated on **negotiation** — never assumed

An older parent receiving `type: "batch"` would apply I5: *unknown type — relay it, do not store it.*
It would forward the batch and store nothing, **silently**. A mixed-version mesh would lose telemetry
with no error anywhere.

So the parent advertises what it understands when a child connects, and **a child batches only when
told the far side can unpack it**:

```jsonc
// parent → child, on connect
{ "supports": ["batch-v1"], "maxBatchItems": 500, "maxBatchBytes": 524288 }
```

No advertisement means individual envelopes, exactly as today. Negotiation is what makes this a
compatible change rather than a flag day.

### 2. Every item's origin is attested, not just the batch's

`meshSocket` today checks that a child may only report about its own subtree. With one payload per
envelope that is one check. In a batch it must run **per item**, because a relay legitimately carries
items from several origins — and therefore a compromised child could otherwise slip a forged item
claiming a peer's origin into an otherwise honest batch.

The rule is unchanged; only its arity is. Forged items are dropped individually and reported; the
rest of the batch proceeds.

### 3. Per-item validation, per-item outcome

**I6 says one bad payload costs exactly one bad payload.** A batch must not be all-or-nothing, or a
single malformed item from a newer child discards 399 good ones — and the child, seeing a rejection,
retries the same batch forever.

```jsonc
// ack
{ "ok": true, "accepted": 398, "relayed": 1,
  "rejected": [ { "index": 237, "reason": "Envelope has no origin node id." } ] }
```

The child drops accepted items and does **not** retry rejected ones — a rejection is a statement
about the payload, and retrying cannot change it.

### 4. Validate first, then apply the survivors in **one transaction**

Both properties at once: per-item isolation, and one fsync instead of 400. Applying inside the
validation loop would mean a throw halfway leaves a partial batch committed with no record of where
it stopped.

### 5. Items apply **in order**

A tombstone followed by an upsert for the same device must land in that order or the device comes
back deleted. Order is already meaningful in the buffer (oldest first, for backfill); the batch
preserves it rather than treating items as a set.

### 6. Bounded, and chunked below the transport limit

socket.io's default `maxHttpBufferSize` is 1 MB, so a batch that grows past it is refused by the
transport with an error that says nothing useful about batching. Bounds: **500 items or 512 KB,
whichever comes first**, chunked by the sender, enforced by the receiver. The parent's advertised
limits are the authority — a child must not assume its own defaults are acceptable to the far side.

### 7. Backpressure counts **items and bytes**, not messages

`maxMessages: 600` per window is a proxy for volume that batching would make meaningless: one message
carrying 5,000 rows would sail past a limit designed to stop exactly that. `admit()` gains an item
count, and the message counter stays for what it is actually good at — catching a chatty peer.

⚠️ Without this, batching is a way *around* the rate limit rather than a way to be polite.

### 8. **Alerts are not batched**

An `alert-event` is the one payload where latency is the point. Batching it behind 400 device
summaries adds up to a full cycle of delay to the message an operator is waiting for. Alerts and
tombstones send immediately; telemetry, device summaries and proof-of-play batch.

This is the difference between "fewer bytes" and "better product", and they are not the same goal.

### 9. Compression: **transport first, explicit second — and only if measured**

Once batched, `permessage-deflate` is negotiated per connection and needs no code at all. The
measurement says deflate on a batched payload is already within a few percent of brotli. Adding an
explicit brotli pass costs main-thread CPU on the child and a second thing to get wrong.

So: batch, enable permessage-deflate, **re-run the script**, and add explicit compression only if the
remaining delta is worth it. Not both because both are available.

### 10. What does not change

- Grant filtering still happens per item, in the projection, before anything is batched. A batch is a
  transport optimisation and must never become a second path with its own idea of what may travel.
- `proof-of-play` stays `INSERT OR IGNORE` and is safe to re-send.
- Clock skew is still measured per item against the **first** receipt.
- The fidelity rules (Phase 4) apply per item: a batch may contain full-fidelity and thinned items
  together, each carrying its own resolution.

---

## Risks

**A batch is a bigger blast radius for a parsing bug.** One malformed batch could wedge a child's
entire report cycle where previously it would have lost one device. Mitigated by per-item validation
and by the child dropping accepted items on ack — but it is the reason the item loop must be wrapped
individually rather than relying on the outer handler.

**Partial acceptance needs the child to track item identity.** The buffer is currently a plain array;
it needs stable indices within a sent batch so `rejected: [{ index }]` means something. Straightforward,
but it is state the child does not keep today.

**Negotiation adds a state to test.** Three paths now exist — batching, not batching, and a parent
that stops advertising mid-session (a downgrade). The third is the one that will not be exercised by
hand.

---

## Order of work

1. Negotiation handshake and the `batch` payload type, sender still emitting singles.
2. Per-item validation, attestation and ack; parent unpacking.
3. Child batching with bounds and chunking, alerts exempt.
4. Backpressure item accounting.
5. Enable `permessage-deflate`, re-run `scripts/measure-mesh-payloads.js`, decide on explicit
   compression with the new numbers.
