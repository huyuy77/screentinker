'use strict';

/*
 * What one node is allowed to see of another.
 *
 * ⚠️ DATA CATEGORIES, NOT READ/WRITE. This is the distinction a client's security review actually
 * turns on. "Read" as a single permission would mean device names, LAN and public WAN addresses,
 * content metadata and screenshots all travelling together into someone else's database — and a
 * client who wants their MSP to see that screens are alive, but not what is playing on them or where
 * they are, would have no way to say so. Every category below is separately grantable and separately
 * deniable.
 *
 * The vocabulary comes from the Phase −1 inventory (docs/mesh-telemetry-inventory.md), which counted
 * what is actually collected rather than what the schema declares. Two consequences of that audit are
 * baked in here:
 *
 *   - PUBLIC/WAN ADDRESS IS ITS OWN CATEGORY, split from LAN. It is populated for 509 of 509
 *     production devices and it locates a client's premises. A "health only" grant that still shipped
 *     the public IP of every screen would fail the review this exists for.
 *   - THERE IS NO wifi-ssid CATEGORY, because that field is being dropped. 94% of it was not an SSID
 *     and the remainder was geolocatable customer network names.
 *
 * ⚠️ EVERY CATEGORY DEFAULTS TO DENIED. An empty grant is a valid grant that yields nothing but the
 * fact that the node exists. There is no "all" shorthand and no wildcard — a grant is an explicit
 * list, so adding a category in a later version cannot retroactively widen an existing edge. That is
 * the single most important property in this file.
 *
 * ⚠️ ENFORCED AT THE SOURCE (invariant I10). The node that owns the data decides what leaves it. A
 * denied category is never sent — not sent-and-filtered, not sent-and-hidden. The receiving node is
 * never trusted to police what it was given, because the whole point is that it belongs to someone
 * else.
 */

/**
 * READ categories — implemented in 2.0.
 * `implies` is documentation of consequence, not a widening: granting `identity` does not
 * auto-grant anything. It records what an operator is really agreeing to.
 */
const READ_CATEGORIES = Object.freeze({
  'health': {
    summary: 'Whether screens are alive and how they are coping',
    fields: 'uptime, storage, RAM, CPU, battery, Wi-Fi signal strength',
    consequence: 'Shows that a screen is up or down. Says nothing about what it is showing.',
  },
  'identity': {
    summary: 'What each screen is called and what it runs',
    fields: 'device name, hardware model, serial, app and OS version',
    consequence: 'Without this, devices appear as opaque ids and are NOT searchable by name. ' +
                 'The empty state must say so, or a health-only grant reads as a broken search.',
  },
  'network-lan': {
    summary: 'Private addresses on the local network',
    fields: 'LAN IPv4/IPv6 address',
    consequence: 'Useful for on-site support. Does not identify the site to an outsider.',
  },
  'network-wan': {
    summary: 'The public internet address the screens appear from',
    fields: 'public/WAN address',
    consequence: '⚠️ Locates the premises. A public IP is geolocatable to a town or building. ' +
                 'Deliberately separate from network-lan so it can be denied on its own.',
  },
  'display': {
    summary: 'What the screen hardware is doing',
    fields: 'attached display, video mode, orientation, resolution',
    consequence: 'Hardware state only. Does not include screenshots — see display-capture.',
  },
  'display-capture': {
    summary: 'Actual images of what is on screen',
    fields: 'screenshots',
    consequence: '⚠️ Reveals the content itself, including anything incidentally on screen. ' +
                 'The most sensitive read category; separate from display for that reason.',
  },
  'content-metadata': {
    summary: 'What is scheduled to play',
    fields: 'playlist and content names, schedules, assignment',
    consequence: 'Reveals campaign and tenant names, which are commercially sensitive on their own.',
  },
  'proof-of-play': {
    summary: 'Evidence that specific content played at specific times',
    fields: 'play logs',
    consequence: 'The billing artifact for advertising. ⚠️ Must not be downsampled at any depth ' +
                 '(see Phase 4): an averaged proof-of-play is worthless as evidence.',
  },
  'diagnostics': {
    summary: 'Why something went wrong',
    fields: 'device events, status log with offline reason, debug logs',
    consequence: 'Can contain error text and URLs from the running content.',
  },
});

/**
 * WRITE categories — modelled now, REJECTED until Phase 5.
 *
 * ⚠️ These exist in the vocabulary and are refused by validation, deliberately. The directive forbids
 * stubs and dormant paths for downward control (invariant I2), and this is not one: nothing here can
 * be granted, so no code path can consult it. What it buys is that the *shape* of a grant does not
 * change when Phase 5 lands — an edge stored in 2.0 is still a valid edge afterwards, and an operator
 * who reads the model today is not surprised later by a permission that did not appear to exist.
 */
const WRITE_CATEGORIES = Object.freeze({
  'content-push': {
    summary: 'Send content and playlists downward',
    consequence: 'This hub will be able to change what plays on your screens.',
  },
  'device-command': {
    summary: 'Reboot, reload, change settings on screens',
    consequence: 'This hub will be able to restart and reconfigure your screens.',
  },
});

const ALL_READ = Object.freeze(Object.keys(READ_CATEGORIES));
const ALL_WRITE = Object.freeze(Object.keys(WRITE_CATEGORIES));

/** Is this a category name we know at all? */
function isKnownCategory(name) {
  return Object.prototype.hasOwnProperty.call(READ_CATEGORIES, name)
      || Object.prototype.hasOwnProperty.call(WRITE_CATEGORIES, name);
}

function isWriteCategory(name) {
  return Object.prototype.hasOwnProperty.call(WRITE_CATEGORIES, name);
}

/**
 * Validate a requested grant.
 *
 * ⚠️ REFUSAL IS EXPLICIT AND OPERATOR-READABLE (directive: "never accept-and-silently-degrade").
 * A node asked for something it will not give says so, in a sentence a person can act on. Quietly
 * dropping the categories it dislikes and accepting the rest is how an operator ends up believing
 * they granted something they did not — or that they granted less than they did.
 *
 * @param {string[]} requested
 * @returns {{ok: true, categories: string[]} | {ok: false, reason: string, rejected: string[]}}
 */
function validateGrant(requested) {
  if (!Array.isArray(requested)) {
    return { ok: false, reason: 'A grant must be a list of data categories.', rejected: [] };
  }

  const unknown = requested.filter((c) => !isKnownCategory(c));
  if (unknown.length) {
    return {
      ok: false,
      rejected: unknown,
      reason: `This node does not recognise the data ${unknown.length === 1 ? 'category' : 'categories'} ` +
              `${unknown.map((c) => `"${c}"`).join(', ')}. It may be newer than this node — ` +
              `known categories are: ${ALL_READ.join(', ')}.`,
    };
  }

  const writes = requested.filter(isWriteCategory);
  if (writes.length) {
    return {
      ok: false,
      rejected: writes,
      reason: `Write access (${writes.join(', ')}) is not available in this version. This node accepts ` +
              `observation only: data flows upward, and no parent can change what plays on this ` +
              `node's screens.`,
    };
  }

  // Duplicates are an operator slip, not an attack — normalise rather than refuse.
  return { ok: true, categories: [...new Set(requested)] };
}

/**
 * Does a validated grant permit this category?
 *
 * Deliberately takes the stored list rather than an edge row, so the check is impossible to
 * accidentally perform against the requesting node's copy of the grant. Callers live on the owning
 * node by construction (I10).
 */
function grantAllows(grantedCategories, category) {
  if (!Array.isArray(grantedCategories)) return false;
  // No wildcard on purpose: a future category must never be implicitly included in an old grant.
  return grantedCategories.includes(category);
}

/** Plain-language consequences, for the confirmation UI on the GRANTING node. */
function describeGrant(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    return ['This node will be visible, but no data about it will be shared.'];
  }
  return categories
    .filter(isKnownCategory)
    .map((c) => (READ_CATEGORIES[c] || WRITE_CATEGORIES[c]).consequence);
}

module.exports = {
  READ_CATEGORIES,
  WRITE_CATEGORIES,
  ALL_READ,
  ALL_WRITE,
  isKnownCategory,
  isWriteCategory,
  validateGrant,
  grantAllows,
  describeGrant,
};
