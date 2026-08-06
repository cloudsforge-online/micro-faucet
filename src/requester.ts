/**
 * Who is asking, expressed so that the answer is not personal data.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN IP ADDRESS IS PERSONAL DATA (GDPR Art. 4(1), and Breyer C-582/14 for the dynamic case), SO
 * THIS SERVICE NEVER STORES ONE.** `faucet_requester_grants.requester` used to be
 * `ip:<raw address>` as a PRIMARY KEY, with no retention period and nothing that pruned it — a
 * permanent, unminimised record of every network that has ever asked for a testnet drip, held for
 * a purpose that never needed it. `micro-org#163`.
 *
 * The purpose is legitimate and is kept: stop one person draining a test faucet. What the purpose
 * actually requires is **equality** — "have I seen this asker before, this window?" — and nothing
 * else. It never needs to read the address back, never needs to reverse the key, never needs to
 * show it to an operator, and never needs a row older than the window it bounds. Art. 5(1)(c) says
 * take only what the purpose needs; Art. 5(1)(e) says keep it only as long as the purpose needs.
 * Equality is what a keyed hash gives, so a keyed hash is what is stored.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The three steps, and why each one is there rather than the one before it
 *
 * ### 1. TRUNCATE, before anything else touches the value
 *
 * `truncateIp` from `@cloudsforge/contracts-auth` — the SAME function `identity` truncates with at
 * `identity/src/sessions.ts`, so the estate has one definition of "a network prefix" and not
 * two. IPv4 → a /24, IPv6 → a /48, and an IPv4-mapped IPv6 address → the /24 of the address inside
 * it rather than a /48 that would have kept all thirty-two IPv4 bits.
 *
 * Truncation is FIRST because it is the only step that is irreversible by construction: 254 hosts
 * of a /24 collapse onto one value before any key, any salt or any hash is involved, so a mistake
 * in the steps below cannot expose an address that was already gone.
 *
 * **AND IT MAKES THE RATE LIMIT STRONGER, NOT WEAKER.** This is the part that is easy to get
 * backwards. `server.ts` used to key on a whole address and admitted the hole in the comment above
 * it: an IPv6 /64 has 2^64 addresses, so an attacker with one ordinary residential IPv6 allocation
 * had 2^64 distinct requester keys and the limit was decorative against them. Keyed on a /48 that
 * same attacker has ONE key. Minimisation and the control point the same way here, which is
 * unusual and is why it is written down.
 *
 * The cost is stated too: legitimate users behind one /24 — an office, a campus, a carrier-grade
 * NAT pool — now share a bucket and can collectively take `FAUCET_REQUESTER_LIMIT` drips per
 * window instead of that many each. That is acceptable because this limit was never the control
 * that bounds the loss (`limits.ts` says so, and the budget is), and because the per-address
 * cooldown is the one an honest user actually meets.
 *
 * ### 2. KEYED-HASH the prefix, with a secret that is not in this repository
 *
 * A bare `sha256` of a /24 is worthless and it is worth being exact about why: there are 2^24
 * IPv4 /24s, about seventeen million, which is a complete rainbow table in seconds on a laptop.
 * The hash would be a reversible encoding wearing a hash's clothes. **The secret is the entire
 * control**, so it is HMAC-SHA256 under a deployment secret, never a constant in source.
 *
 * That secret is held by the deployment and not by the database, which is the separation Art. 4(5)
 * asks for in as many words: pseudonymisation requires the additional information to be "kept
 * separately and subject to technical and organisational measures". A database dump, a backup, a
 * replica, an operator with `psql` — none of them can turn `r1:9f3c…` back into a network.
 *
 * 128 bits of the digest are kept, not 256. Collision resistance at 2^64 is far beyond the scale
 * of an IPv4 address space; the shorter key is a smaller primary key and a shorter index.
 *
 * ### 3. ROTATE THE SALT ON A CLOCK, AND DELETE ON THE SAME ONE
 *
 * The salt is `HMAC(secret, epoch)` where `epoch = floor(now / retentionSeconds)`, and
 * `retentionSeconds` is one number used twice because rotation and pruning are one event.
 *
 * **WHAT ROTATION BUYS, STATED EXACTLY, BECAUSE IT IS EASY TO CLAIM TOO MUCH.** The epoch salt is
 * DERIVED, not random and discarded, so anyone holding the deployment secret can recompute any
 * epoch they like. Rotation is therefore not what makes an old row unreadable — the truncation and
 * the secret are. What rotation guarantees is that **a row from a previous period can never again
 * be matched by this service**: no request, from anyone, will ever derive that key again. A stale
 * row has no function, so deleting it costs nothing and can never be argued down on operational
 * grounds — which is precisely the argument that keeps retention policies unenforced.
 *
 * So the control against a party who holds the secret is **the deletion**, not the rotation. That
 * is the whole reason `pruneRequesters` in `jobs.ts` is a recurring leased job that actually runs
 * rather than a period written in a document. Rotation is the defence in depth underneath it: if
 * the prune stops, the estate has a storage-limitation failure to fix, not a rate limit that has
 * quietly started matching year-old rows.
 *
 * Rotation being DERIVED rather than stored is also deliberate. There is no salt table to read, no
 * cache to invalidate and no coordination between replicas: every replica computes the same epoch
 * from its own clock, and the period is measured in days, so clock skew that would matter is skew
 * that has already broken the certificates. The alternative — a random salt in a row, rotated by
 * whichever worker gets there first — would make an escaped BACKUP unreadable too, which is a real
 * gain, at the price of a second piece of state, a second race, and a window in which one replica
 * keys differently from its neighbour. For counters that are deleted every two days, the trade is
 * not worth it. If this table ever outlives its rotation period, revisit that sentence first.
 *
 * **THE COST, STATED RATHER THAN DISCOVERED.** At an epoch boundary every counter effectively
 * resets, so one prefix may take up to `FAUCET_REQUESTER_LIMIT` extra drips per rotation. With the
 * default period that is 3 extra drips per network per two days, and the budget bounds them like
 * every other drip. A hard, mechanically-enforced ceiling on how long any pseudonymous network
 * identifier can exist is worth more than three testnet drips.
 *
 * ## What a caller with no usable address gets
 *
 * `truncateIp` returns null for anything that is not an address, so a malformed or absent
 * `x-forwarded-for` produces the sentinel below rather than a fragment that looks like a network.
 * Every such caller shares one bucket. That is exactly what the previous code did with
 * `ip:unknown`, so it is not a new behaviour — but it IS a real property: a broken proxy in front
 * of this service collapses everyone onto one counter. It is left that way because the alternative
 * is a caller who can opt out of the limit by sending a junk header.
 */

import { createHmac } from 'node:crypto'
import { truncateIp } from '@cloudsforge/contracts-auth'

/**
 * The version marker on every stored key.
 *
 * It is in the value, not only in a migration note, so that changing how a key is derived is
 * forced to change how it LOOKS — and a mixed table is then legible rather than silently half
 * one scheme and half the other.
 */
export const REQUESTER_KEY_VERSION = 'r1'

/**
 * The exact shape of a stored requester key, in JavaScript and — byte for byte the same regex — in
 * the Postgres CHECK added by migration 4.
 *
 * A POSITIVE shape rather than "not an IP literal". Both would refuse `203.0.113.7`; only this one
 * also refuses a username, an email, a session id, a truncated prefix that was never hashed, and
 * whatever the next writer of this table thinks a requester is. The constraint that enumerates
 * what is forbidden is a constraint that is one idea behind its attacker.
 */
export const REQUESTER_KEY_PATTERN = /^r1:[0-9a-f]{32}$/

/** The Postgres spelling of the pattern above. Kept adjacent so the two cannot drift apart. */
export const REQUESTER_KEY_SQL_PATTERN = '^r1:[0-9a-f]{32}$'

/**
 * The bucket for a caller whose address could not be truncated. Hashed like any other subject, so
 * it is indistinguishable in the table and satisfies the same CHECK.
 */
export const UNKNOWN_SUBJECT = 'unknown'

/**
 * Domain separation. The salt is derived from a deployment secret that is also used elsewhere, so
 * this label is what stops a key derived here from being meaningful anywhere else — and stops a
 * digest computed elsewhere from being a valid requester key.
 */
const SALT_LABEL = 'cloudsforge/faucet/requester-salt/v1'
const KEY_LABEL = 'cloudsforge/faucet/requester-key/v1'

export interface RequesterConfig {
  /**
   * The pseudonymisation secret. `env.ts` validates it; it is never logged, never returned by a
   * route and never written to the database.
   */
  readonly salt: string
  /**
   * How long a requester row may exist, in seconds, and therefore also the salt's rotation period.
   * They are ONE number because they are one event — see the header.
   */
  readonly retentionSeconds: number
}

/**
 * Which rotation period `at` falls in. Exported for the tests and for `jobs.ts`, which reports it
 * so that an operator can see a rotation happen without reading a salt.
 */
export function requesterEpoch(retentionSeconds: number, at: Date = new Date()): number {
  if (!Number.isInteger(retentionSeconds) || retentionSeconds <= 0) {
    throw new RangeError(`retentionSeconds must be a positive whole number (got ${retentionSeconds})`)
  }
  return Math.floor(at.getTime() / 1000 / retentionSeconds)
}

/**
 * The stored key for one asker. **The only function in this service that is allowed to see a raw
 * address, and it returns before that value is used for anything else.**
 *
 * `address` is whatever the ingress presented — it may be absent, malformed, or attacker-chosen.
 * None of those cases returns anything derived from the raw text: they all fall through to
 * `UNKNOWN_SUBJECT`, so an unbounded header can no longer become an unbounded primary key either.
 */
export function requesterKey(
  address: string | undefined,
  config: RequesterConfig,
  at: Date = new Date(),
): string {
  // Truncation first, and note the order: nothing below ever sees `address`.
  const subject = (address ? truncateIp(address) : null) ?? UNKNOWN_SUBJECT
  const epoch = requesterEpoch(config.retentionSeconds, at)

  // The epoch is folded into the SALT rather than into the message, so two epochs are two
  // independent keys rather than two messages under one key. Learning one epoch's derivation
  // teaches nothing about the next.
  const rotating = createHmac('sha256', config.salt).update(`${SALT_LABEL}\n${epoch}`, 'utf8').digest()
  const digest = createHmac('sha256', rotating).update(`${KEY_LABEL}\n${subject}`, 'utf8').digest('hex')

  return `${REQUESTER_KEY_VERSION}:${digest.slice(0, 32)}`
}

/**
 * Derive the pseudonymisation secret from another deployment secret.
 *
 * Used when `FAUCET_REQUESTER_SALT` is not set. The result is exactly as secret as the input — no
 * more, and deliberately no less: it is HMAC under a label, which is what HKDF-Expand does, so a
 * deployment that holds one strong secret gets a strong salt without a second variable to provide,
 * and a deployment that sets the dedicated variable gets the two rotated independently.
 *
 * A CONSTANT DEFAULT WOULD HAVE BEEN THE FAILURE THIS WHOLE FILE IS ABOUT: a pseudonymisation key
 * committed to a repository is a pseudonymisation key that does not exist, and it would have
 * booted, passed every test and protected nothing.
 */
export function deriveRequesterSalt(secret: string): string {
  return createHmac('sha256', secret).update(SALT_LABEL, 'utf8').digest('hex')
}
