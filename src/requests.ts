/**
 * Accepting a request, which is the only thing that happens on an HTTP thread.
 *
 * **NOTHING HERE SIGNS, READS A NONCE OR TOUCHES THE CHAIN.** A request is parsed, limited,
 * fingerprinted and written down; a worker holding the chain lease does the rest. That split is not
 * tidiness — it is what stops the number of signed transactions from being decided by how many
 * times a client retried. `settlement/src/withdrawals.ts` draws the same line and gives the
 * same reason: "a build here would mean the relay's retry policy decided how many transactions got
 * signed".
 *
 * The frozen service does the opposite. `handleDrip` (`stack/repos/hearth/tools/faucet/
 * src/server.js`) parses, reserves, reads two balances and BROADCASTS, all inside the
 * request handler, and answers 200 with a transaction hash. Two consequences follow and both are
 * defects rather than trade-offs:
 *
 *   1. A client that times out at four seconds and retries has caused a broadcast it will never
 *      learn about, and its retry passes the cooldown only because `release()` ran on the way out.
 *   2. The response promises `status: 'broadcast — poll eth_getTransactionReceipt'`
 *      (`server.js`), which is honest, but it means the service's own record of what happened
 *      ends the moment the socket closes. Nothing tracks confirmation, so a transaction dropped
 *      from the mempool is a drip the faucet believes it made.
 *
 * Here the reply is 202 with a dispense id. The caller polls `GET /v1/drips/:id`, and the service
 * still knows the answer an hour later.
 *
 * ## Two independent dedupes, catching different things
 *
 * `dispenses_fingerprint_uniq` stops the SAME request arriving twice — a client retrying after a
 * lost response. `dispenses_live_recipient_uniq` stops two DIFFERENT requests for one address being
 * live at once, which is what two concurrent requests from two replicas produce. Either one alone
 * leaves a hole, and the second is the one the cooldown row cannot cover, because the cooldown row
 * only settles the second request once the first has COMMITTED.
 */

import type { Db, Tx } from './db.ts'
import { AddressError, addressKey, parseRecipient, sameAddress } from './address.ts'
import { defaultIdempotencyKey, fingerprint } from './fingerprint.ts'
import { isUniqueViolation } from './dispense.ts'
import { reserve, type LimitConfig, type RefusalCode } from './limits.ts'

/**
 * Private control flow: this request is already known, discovered from inside the transaction.
 *
 * Thrown so that the transaction ROLLS BACK — the reservation it took on the way to this discovery
 * must not survive — and caught immediately below. It never reaches a route.
 */
class AlreadyAccepted extends Error {
  readonly accepted: Omit<Accepted, 'duplicate'>
  constructor(accepted: Omit<Accepted, 'duplicate'>) {
    super('already accepted')
    this.name = 'AlreadyAccepted'
    this.accepted = accepted
  }
}

export class DripRefusedError extends Error {
  readonly code: RefusalCode | 'invalid_address' | 'own_address'
  readonly status: number
  readonly retryAfterSeconds: number | null
  constructor(
    status: number,
    code: DripRefusedError['code'],
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = 'DripRefusedError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export interface AcceptInput {
  readonly address: unknown
  readonly idempotencyKey?: string | undefined
  readonly requester: string
}

export interface AcceptDeps {
  readonly sql: Db
  readonly chainId: number
  readonly fundingAddress: string
  readonly limits: LimitConfig
  readonly now?: () => Date
}

export interface Accepted {
  readonly id: string
  readonly recipient: string
  readonly amountWei: bigint
  readonly status: string
  /** True when this request was already known — a retry, answered with the original dispense. */
  readonly duplicate: boolean
}

/**
 * Take one request and turn it into a `queued` dispense, or refuse it.
 *
 * The order of checks is cheapest-first, which is the frozen service's ordering
 * (`server.js`) and worth keeping verbatim: parse, then the address rules, then the database.
 * Everything an anonymous caller can make this service do is gated behind something it had to pass
 * for free first.
 */
export async function acceptDrip(deps: AcceptDeps, input: AcceptInput): Promise<Accepted> {
  /* ── 1. Parse. Free, pure, and rejects most abuse. ─────────────────────────────────────── */
  let recipient: string
  try {
    recipient = parseRecipient(input.address)
  } catch (err) {
    if (err instanceof AddressError) throw new DripRefusedError(400, 'invalid_address', err.message)
    throw err
  }

  /* ── 2. Never the faucet's own address. ────────────────────────────────────────────────────
   *
   * Kept from `server.js`. Not a nicety: the drip would succeed, cost the gas, and appear
   * in the ledger as a payout that funded nobody — and it would consume a cooldown slot and a
   * budget slot for an address that can never be over its balance ceiling, so a script pointed at
   * it drains the budget for ever at one drip per cooldown.
   */
  if (sameAddress(recipient, deps.fundingAddress)) {
    throw new DripRefusedError(400, 'own_address', "that is the faucet's own funding address")
  }

  /* ── 3. THE AMOUNT IS A SERVER-SIDE CONSTANT. ──────────────────────────────────────────────
   *
   * `input` has no amount field and there is nowhere for one to arrive. `server.js` says
   * why and it is the single most important sentence in the frozen repository: "every faucet that
   * has ever been drained let the caller influence the amount".
   */
  const amountWei = deps.limits.dripWei

  const now = deps.now?.() ?? new Date()
  const idempotencyKey =
    input.idempotencyKey && input.idempotencyKey.trim().length > 0
      ? input.idempotencyKey.trim().slice(0, 200)
      : defaultIdempotencyKey(recipient, deps.limits.addressCooldownSeconds, now)

  const key = fingerprint({
    recipient,
    amountWei,
    chainId: deps.chainId,
    idempotencyKey,
  })

  /* ── 4. Already known? ─────────────────────────────────────────────────────────────────────
   *
   * Checked BEFORE the reservation, so a retry does not consume a second budget slot on its way to
   * being recognised as a retry. The insert below is still guarded by the unique index, because
   * this read and that write are not atomic with each other and two simultaneous retries would
   * both get here.
   */
  const existing = await findByFingerprint(deps.sql, key)
  if (existing) return { ...existing, duplicate: true }

  /* ── 5. The limits, and the insert, in ONE transaction. ────────────────────────────────────
   *
   * A reservation taken by a transaction whose insert then fails must not survive — otherwise the
   * loser of a race between two requests for one address pays a day's cooldown for a dispense that
   * does not exist. Rolling back is how that is guaranteed, rather than by a compensating delete
   * that has its own failure mode.
   */
  const stored = await deps.sql
    .begin(async (tx) => {
      const reservation = await reserve(tx as unknown as Tx, { recipient, requester: input.requester }, deps.limits)
      if (!reservation.ok) {
        /*
         * A REFUSAL IS NOT THE ANSWER IF THIS REQUEST HAS ALREADY BEEN ACCEPTED.
         *
         * The check at step 4 and this transaction are not atomic with each other, so a retry that
         * arrived while the original was still committing read "not found" there and then met the
         * original's freshly-committed cooldown row here. Returning a 429 to it would be actively
         * wrong: the caller would be told to wait a day for a drip it has already been granted,
         * and its own dispense id — the thing it needs in order to poll — would never be served.
         *
         * So the fingerprint is looked up once more, now that the winner has committed. This is
         * cheap (one indexed read on a path that is about to return a refusal anyway) and it is
         * the difference between idempotency that holds under concurrency and idempotency that
         * holds only when the retry is late enough.
         */
        const alreadyAccepted = await findByFingerprint(tx as unknown as Db, key)
        if (alreadyAccepted) throw new AlreadyAccepted(alreadyAccepted)
        throw new DripRefusedError(429, reservation.code, reservation.message, reservation.retryAfterSeconds)
      }
      const rows = (await tx`
        insert into dispenses (recipient, requester, status, amount_wei, chain_id, fingerprint)
        values (${addressKey(recipient)}, ${input.requester}, 'queued',
                ${amountWei.toString(10)}::numeric, ${deps.chainId}, ${key})
        returning id, recipient, status, amount_wei
      `) as ReadonlyArray<{ id: string; recipient: string; status: string; amount_wei: string }>
      return rows[0]!
    })
    .catch(async (err: unknown) => {
      // Not a failure: the reservation found that this exact request already has a dispense. The
      // transaction rolled back, which is what was wanted — nothing extra was consumed.
      if (err instanceof AlreadyAccepted) return { ...err.accepted, duplicate: true as const }
      if (!isUniqueViolation(err)) throw err
      // One of the two unique indexes refused. Both are expected outcomes of a correct race and
      // both roll the reservation back with the transaction, so nothing was consumed.
      //
      //   fingerprint  — two simultaneous retries of one request. Answer with the one that won.
      //   live recipient — two DIFFERENT requests for one address. The second is refused, and
      //                    refused as a cooldown rather than as a 409: from the caller's side "a
      //                    drip for this address is already in progress" and "this address was
      //                    funded a moment ago" are the same fact.
      const winner = await findByFingerprint(deps.sql, key)
      if (winner) return { ...winner, duplicate: true }
      throw new DripRefusedError(
        429,
        'address_cooldown',
        'a drip for this address is already in progress',
        deps.limits.addressCooldownSeconds,
      )
    })

  if ('duplicate' in stored) return stored
  return {
    id: stored.id,
    recipient: stored.recipient,
    amountWei: BigInt(stored.amount_wei),
    status: stored.status,
    duplicate: false,
  }
}

async function findByFingerprint(sql: Db, key: string): Promise<Omit<Accepted, 'duplicate'> | null> {
  const rows = (await sql`
    select id, recipient, status, amount_wei from dispenses where fingerprint = ${key}
  `) as ReadonlyArray<{ id: string; recipient: string; status: string; amount_wei: string }>
  const row = rows[0]
  if (!row) return null
  return { id: row.id, recipient: row.recipient, status: row.status, amountWei: BigInt(row.amount_wei) }
}

export interface DispenseView {
  readonly id: string
  readonly recipient: string
  readonly status: string
  readonly amountWei: bigint
  readonly txHash: string | null
  readonly confirmations: number
  readonly blockNumber: bigint | null
  readonly failureReason: string | null
  readonly createdAt: Date
  readonly settledAt: Date | null
}

/**
 * One dispense, for the caller that is polling.
 *
 * Note what is NOT selected: `raw_tx`, `nonce` and `custody_audit_id`. The raw transaction is a
 * signature over the funding address's authority, and while it cannot be replayed on another chain
 * — EIP-155 binds it to 7412 — there is no reason for a public read surface to serve it, and rule 6
 * is answered most simply by there being no query that returns it.
 */
export async function readDispense(sql: Db, id: string): Promise<DispenseView | null> {
  // Bounded before it reaches the database: an id that is not a UUID is a 404, not a 22P02 that
  // surfaces as a 500 and puts a caller-controlled string in an error log.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
  const rows = (await sql`
    select id, recipient, status, amount_wei, tx_hash, confirmations, block_number,
           failure_reason, created_at, settled_at
      from dispenses where id = ${id}::uuid
  `) as ReadonlyArray<{
    id: string
    recipient: string
    status: string
    amount_wei: string
    tx_hash: string | null
    confirmations: number
    block_number: string | null
    failure_reason: string | null
    created_at: Date
    settled_at: Date | null
  }>
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    recipient: row.recipient,
    status: row.status,
    amountWei: BigInt(row.amount_wei),
    txHash: row.tx_hash,
    confirmations: row.confirmations,
    blockNumber: row.block_number === null ? null : BigInt(row.block_number),
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  }
}

/** Queue depth by status, for the gauges and for `/readyz`. */
export async function dispenseCounts(sql: Db): Promise<ReadonlyMap<string, number>> {
  const rows = (await sql`
    select status, count(*)::int as n from dispenses group by status
  `) as ReadonlyArray<{ status: string; n: number }>
  return new Map(rows.map((row) => [row.status, row.n]))
}
