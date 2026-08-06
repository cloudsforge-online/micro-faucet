/**
 * The idempotency fingerprint: what makes two requests the same request.
 *
 * `ledger/src/idempotency.test.ts` states the rule this file exists to obey, and it is stated as a
 * negative because that is the half people get wrong:
 *
 *     a retry with a NEW correlationId fingerprints the same          (idempotency.test.ts)
 *     a DIFFERENT amount under the same correlationId does not        (idempotency.test.ts)
 *
 * **A per-attempt field must not be in the fingerprint.** A `correlationId`, a `requestId`, a
 * timestamp and a retry counter are all properties of the ATTEMPT, not of the request, and a
 * client that retries a request whose response it never saw sends a new one of each. Fold any of
 * them in and the retry is a different request, which for this service means a second drip for one
 * ask — precisely the thing idempotency is supposed to prevent.
 *
 * So the input type is closed and narrow. It carries the three facts that make a drip what it is
 * and nothing that varies between attempts, and adding a field to it is a decision somebody makes
 * on purpose rather than a field that gets spread in.
 *
 * `amount` is a `bigint` and is rendered as its decimal string. Never `JSON.stringify`, which
 * throws on a bigint, and never `Number(amount)`, which is the float defect rule 4 names: 1e19 wei
 * and 1e19 + 1 wei are the same double and would fingerprint identically.
 */

import { createHash } from 'node:crypto'

/**
 * Everything that makes a drip request distinct. Deliberately closed.
 *
 * `idempotencyKey` is the caller's own name for the request when it supplies one — the field that
 * lets a client that genuinely wants a SECOND drip for the same address after the cooldown say so.
 * Without it, `(recipient, amount, chainId)` alone would make every request for one address for
 * ever the same request, and the second legitimate drip a day later would be answered with the
 * first one's transaction hash.
 */
export interface DripIdentity {
  readonly recipient: string
  readonly amountWei: bigint
  readonly chainId: number
  readonly idempotencyKey: string
}

/**
 * A stable rendering, hashed. Field ORDER cannot change the answer, because the fields are named
 * and written in a fixed order here rather than iterated from an object.
 */
export function fingerprint(identity: DripIdentity): string {
  const canonical = [
    `recipient=${identity.recipient.toLowerCase()}`,
    // The decimal string of the bigint. Exact at any magnitude.
    `amount=${identity.amountWei.toString(10)}`,
    `chain=${identity.chainId}`,
    `key=${identity.idempotencyKey}`,
  ].join('\n')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * The default idempotency key when a caller supplies none: the recipient and the cooldown bucket.
 *
 * A caller that sends no key still gets idempotency, because the alternative is that the retry of
 * a request whose response was lost becomes a second drip. Bucketing by the cooldown window is the
 * right granularity: within one cooldown the caller cannot have a second drip anyway, so collapsing
 * every keyless request in the window onto one fingerprint takes nothing away — and past the
 * window, when a second drip IS allowed, the bucket has moved and the request is genuinely new.
 */
export function defaultIdempotencyKey(
  recipient: string,
  cooldownSeconds: number,
  now: Date = new Date(),
): string {
  const bucket = Math.floor(now.getTime() / (cooldownSeconds * 1000))
  return `auto:${recipient.toLowerCase()}:${bucket}`
}
