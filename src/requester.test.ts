/**
 * The requester key: what it must never contain, and what it must still be able to do.
 *
 * These cases run without a database, deliberately. The property under test — "a stored requester
 * cannot be turned back into a person" — is a property of the derivation, and a derivation that
 * needed Postgres to be proved would be a derivation nobody re-checks after changing it.
 *
 * **No case here uses a real address.** Every literal is from a documentation range reserved for
 * exactly this purpose: 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24 (RFC 5737) and
 * 2001:db8::/32 (RFC 3849).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  REQUESTER_KEY_PATTERN,
  REQUESTER_KEY_SQL_PATTERN,
  UNKNOWN_SUBJECT,
  deriveRequesterSalt,
  requesterEpoch,
  requesterKey,
} from './requester.ts'

const CONFIG = { salt: 'a-test-only-requester-salt-0000000000', retentionSeconds: 172_800 } as const

/** A fixed instant so an epoch boundary is a decision in a case rather than a Tuesday. */
const T0 = new Date('2026-08-05T12:00:00.000Z')

describe('the requester key', () => {
  /* ------------------------------------------------------- what it must not contain */

  describe('what it must never contain', () => {
    /**
     * The one that matters. Stated as a search over the WHOLE key rather than as a shape
     * assertion, because a shape assertion passes on a key that happens to have an address
     * appended to it, and this is the failure the issue is about.
     */
    it('contains no part of the address it was derived from', () => {
      for (const address of ['203.0.113.57', '198.51.100.9', '2001:db8:1234:5678:9abc:def0:1234:5678']) {
        const key = requesterKey(address, CONFIG, T0)
        for (const fragment of address.split(/[.:]/).filter((part) => part.length > 1)) {
          assert.ok(!key.includes(fragment), 'a fragment of the address survived into the stored key')
        }
        assert.ok(!key.includes(address))
      }
    })

    it('is the same for every host inside one IPv4 /24', () => {
      // The truncation, observed rather than trusted: .1 and .254 are 253 different people and one
      // stored value, and that collapse happens BEFORE the hash so no key can undo it.
      const first = requesterKey('203.0.113.1', CONFIG, T0)
      const last = requesterKey('203.0.113.254', CONFIG, T0)
      assert.equal(first, last)
    })

    it('is the same for every host inside one IPv6 /48, which is where the old limit was decorative', () => {
      // `server.ts` used to key on a whole address and admitted an IPv6 /64 has 2^64 of them. Two
      // addresses that far apart are now one bucket, so truncation TIGHTENED the limit here.
      const a = requesterKey('2001:db8:1234:5678::1', CONFIG, T0)
      const b = requesterKey('2001:db8:1234:ffff:ffff:ffff:ffff:ffff', CONFIG, T0)
      assert.equal(a, b)
    })

    it('separates two different networks', () => {
      assert.notEqual(requesterKey('203.0.113.1', CONFIG, T0), requesterKey('198.51.100.1', CONFIG, T0))
      assert.notEqual(requesterKey('2001:db8:1::1', CONFIG, T0), requesterKey('2001:db8:2::1', CONFIG, T0))
    })

    it('does not treat an IPv4-mapped IPv6 address as an IPv6 network', () => {
      // Node behind a proxy hands back `::ffff:a.b.c.d`. Truncating that as IPv6 would keep all
      // thirty-two IPv4 bits inside the /48 — the exact opposite of the intent — so the mapped
      // form and the bare form must reach the same bucket.
      assert.equal(requesterKey('::ffff:203.0.113.57', CONFIG, T0), requesterKey('203.0.113.57', CONFIG, T0))
    })
  })

  /* ------------------------------------------------------- the shape, and the schema */

  describe('the shape the database enforces', () => {
    it('matches the pattern for an address, for junk, and for nothing at all', () => {
      for (const input of [
        '203.0.113.7',
        '2001:db8::1',
        '[2001:db8:1234::1]',
        'fe80::1%eth0',
        'not-an-address',
        'x'.repeat(64),
        '',
        undefined,
      ]) {
        assert.match(requesterKey(input, CONFIG, T0), REQUESTER_KEY_PATTERN)
      }
    })

    /**
     * The JavaScript regex and the Postgres CHECK are one rule written twice, so this is the case
     * that stops them drifting. Migration 4 embeds the SQL string literally; if it is edited here
     * without being edited there, `migrations.test.ts` fails too.
     */
    it('is the same pattern the schema states', () => {
      assert.equal(REQUESTER_KEY_PATTERN.source, REQUESTER_KEY_SQL_PATTERN)
    })

    it('refuses a raw address as a stored key, which is the whole constraint', () => {
      for (const raw of ['203.0.113.7', 'ip:203.0.113.7', '2001:db8::1', 'ip:unknown']) {
        assert.doesNotMatch(raw, REQUESTER_KEY_PATTERN)
      }
    })

    it('is bounded however long the header was', () => {
      // The old code sliced the raw header to 64 characters and stored it. The length of the key
      // is now a property of the derivation and not of anything a caller sends.
      const short = requesterKey('203.0.113.7', CONFIG, T0)
      const absurd = requesterKey('9'.repeat(4_000), CONFIG, T0)
      assert.equal(short.length, absurd.length)
      assert.equal(short.length, 35)
    })
  })

  /* ------------------------------------------------------- the unusable address */

  describe('a caller with no usable address', () => {
    it('collapses every unparseable value onto one bucket, as the old code did', () => {
      const junk = requesterKey('not-an-address', CONFIG, T0)
      assert.equal(junk, requesterKey('another-thing-entirely', CONFIG, T0))
      assert.equal(junk, requesterKey(undefined, CONFIG, T0))
      assert.equal(junk, requesterKey('', CONFIG, T0))
    })

    it('does not leak the sentinel into the key either', () => {
      assert.ok(!requesterKey(undefined, CONFIG, T0).includes(UNKNOWN_SUBJECT))
    })

    it('keeps a junk header out of a real network bucket', () => {
      // Otherwise a caller could pick which bucket to share by sending an unparseable value that
      // happened to hash the way a network does.
      assert.notEqual(requesterKey('not-an-address', CONFIG, T0), requesterKey('203.0.113.7', CONFIG, T0))
    })
  })

  /* ------------------------------------------------------- the secret, and the rotation */

  describe('the salt', () => {
    it('changes every key, so a hash without the secret is not the stored value', () => {
      const other = { ...CONFIG, salt: 'a-different-test-only-salt-0000000000' }
      assert.notEqual(requesterKey('203.0.113.7', CONFIG, T0), requesterKey('203.0.113.7', other, T0))
    })

    it('is derived from another secret rather than defaulted to a constant', () => {
      const a = deriveRequesterSalt('one-deployment-secret-of-enough-length')
      const b = deriveRequesterSalt('another-deployment-secret-of-length')
      assert.notEqual(a, b)
      assert.equal(a, deriveRequesterSalt('one-deployment-secret-of-enough-length'))
      assert.equal(a.length, 64)
      // The point of the derivation: nothing about the input survives into the output, so a salt
      // derived from FAUCET_TOKEN is not a place FAUCET_TOKEN can be read out of.
      assert.ok(!a.includes('one-deployment-secret'))
    })
  })

  describe('rotation', () => {
    it('is stable inside a period', () => {
      const early = new Date(T0.getTime())
      const later = new Date(T0.getTime() + 60_000)
      assert.equal(requesterEpoch(CONFIG.retentionSeconds, early), requesterEpoch(CONFIG.retentionSeconds, later))
      assert.equal(requesterKey('203.0.113.7', CONFIG, early), requesterKey('203.0.113.7', CONFIG, later))
    })

    /**
     * The property that makes the prune free: after a rotation nothing this service ever computes
     * will match a row written before it, so an unpruned row is not a row that still limits
     * somebody — it is only a row that should not exist.
     */
    it('makes a key from the previous period unreachable', () => {
      const next = new Date(T0.getTime() + CONFIG.retentionSeconds * 1_000)
      assert.equal(requesterEpoch(CONFIG.retentionSeconds, next), requesterEpoch(CONFIG.retentionSeconds, T0) + 1)
      assert.notEqual(requesterKey('203.0.113.7', CONFIG, T0), requesterKey('203.0.113.7', CONFIG, next))
    })

    it('refuses a period that is not a positive whole number of seconds', () => {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        assert.throws(() => requesterEpoch(bad, T0), RangeError)
      }
    })
  })
})
