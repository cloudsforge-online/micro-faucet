/**
 * The idempotency fingerprint.
 *
 * These cases are `ledger/src/idempotency.test.ts` applied to this service's identity type. The
 * rule they exist to hold is stated as a negative there and it is the half people get wrong: **a
 * per-attempt field must not be in the fingerprint**, because a retry of a request whose response
 * was lost carries a new one of each.
 *
 * Here the consequence is concrete. Fold a `correlationId` in and a retried drip request is a
 * different request, which means a second drip for one ask — precisely what idempotency exists to
 * prevent.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultIdempotencyKey, fingerprint, type DripIdentity } from './fingerprint.ts'

const ALICE = '0x00000000000000000000000000000000000000a1'

function identity(overrides: Partial<DripIdentity> = {}): DripIdentity {
  return {
    recipient: ALICE,
    amountWei: 10n ** 19n,
    chainId: 7412,
    idempotencyKey: 'client-key-1',
    ...overrides,
  }
}

describe('what makes two requests the same request', () => {
  /**
   * **The headline.** The type has no field for a correlation id, a request id or a timestamp, so
   * there is nowhere for one to be folded in — and a caller that adds one to the object it passes
   * cannot change the answer, because the fields are named explicitly rather than iterated.
   */
  it('a retry carrying different per-attempt fields fingerprints the same', () => {
    const first = { ...identity(), correlationId: 'req-aaa', attempt: 1, receivedAt: '2026-07-31T00:00:00Z' }
    const retry = { ...identity(), correlationId: 'req-bbb', attempt: 2, receivedAt: '2026-07-31T00:00:09Z' }
    assert.equal(fingerprint(first), fingerprint(retry))
  })

  it('a different amount is a different request', () => {
    assert.notEqual(fingerprint(identity()), fingerprint(identity({ amountWei: 10n ** 19n + 1n })))
  })

  it('a different recipient is a different request', () => {
    assert.notEqual(fingerprint(identity()), fingerprint(identity({ recipient: `0x${'b'.repeat(40)}` })))
  })

  it('a different chain is a different request', () => {
    assert.notEqual(fingerprint(identity()), fingerprint(identity({ chainId: 7411 })))
  })

  it("a different idempotency key is a different request — that is what the key is for", () => {
    assert.notEqual(fingerprint(identity()), fingerprint(identity({ idempotencyKey: 'client-key-2' })))
  })

  it('field order does not change the fingerprint', () => {
    const a: DripIdentity = { recipient: ALICE, amountWei: 1n, chainId: 7412, idempotencyKey: 'k' }
    const b: DripIdentity = { idempotencyKey: 'k', chainId: 7412, amountWei: 1n, recipient: ALICE }
    assert.equal(fingerprint(a), fingerprint(b))
  })

  it('one account has one fingerprint, whatever the spelling of its address', () => {
    assert.equal(
      fingerprint(identity({ recipient: ALICE.toUpperCase().replace('0X', '0x') })),
      fingerprint(identity({ recipient: ALICE })),
    )
  })
})

describe('the amount is a bigint and is rendered as its decimal string', () => {
  /**
   * Rule 4, at the one place a bigint could quietly become a double. `JSON.stringify` throws on a
   * bigint, so any implementation that reached for it would have had to coerce — and
   * `Number(10n ** 19n)` and `Number(10n ** 19n + 1n)` are the same double, so the two would
   * fingerprint identically and the second request would be answered with the first's transaction.
   */
  it('distinguishes two amounts that are the same double', () => {
    const a = 10n ** 19n
    const b = a + 1n
    assert.equal(Number(a), Number(b), 'precondition: these must be indistinguishable as doubles')
    assert.notEqual(fingerprint(identity({ amountWei: a })), fingerprint(identity({ amountWei: b })))
  })

  it('holds an amount past 2^64, which a Postgres bigint could not', () => {
    const huge = 2n ** 200n
    assert.notEqual(fingerprint(identity({ amountWei: huge })), fingerprint(identity({ amountWei: huge + 1n })))
  })
})

describe('the default key, for a caller that supplies none', () => {
  const COOLDOWN = 3_600

  it('collapses every keyless request inside one cooldown onto one fingerprint', () => {
    const at = new Date('2026-07-31T12:00:00Z')
    const later = new Date('2026-07-31T12:59:59Z')
    assert.equal(
      defaultIdempotencyKey(ALICE, COOLDOWN, at),
      defaultIdempotencyKey(ALICE, COOLDOWN, later),
    )
  })

  /**
   * And past the window it is genuinely a new request. Bucketing rather than a constant is what
   * makes the SECOND legitimate drip — the one the cooldown now permits — reachable at all; a
   * constant key would answer it with the first drip's transaction hash for ever.
   */
  it('is a different key once the cooldown has passed', () => {
    const at = new Date('2026-07-31T12:00:00Z')
    const next = new Date('2026-07-31T13:30:00Z')
    assert.notEqual(
      defaultIdempotencyKey(ALICE, COOLDOWN, at),
      defaultIdempotencyKey(ALICE, COOLDOWN, next),
    )
  })

  it('is per address', () => {
    const at = new Date('2026-07-31T12:00:00Z')
    assert.notEqual(
      defaultIdempotencyKey(ALICE, COOLDOWN, at),
      defaultIdempotencyKey(`0x${'b'.repeat(40)}`, COOLDOWN, at),
    )
  })
})
