/**
 * Driving the chain, one step.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS WHOLE FILE RUNS UNDER A LEASE KEYED ON THE CHAIN, NOT ON THE DISPENSE ROW, AND THAT IS
 * WHERE THE CORRECTNESS LIVES.**
 *
 * `settlement/src/worker.ts` states the defect and it is the same class of bug here, so the
 * fix is the same shape. A per-row guard is not wrong, it is insufficient: two DIFFERENT dispenses,
 * each with its own row, each passing its own perfectly correct conditional update, both read
 * `eth_getTransactionCount` and both get the same answer. Both are signed against one nonce. At
 * most one can ever be mined, and the other is a payment that was signed and broadcast and lost.
 * **The contended resource is the funding address's nonce.** A per-row lease would not have stopped
 * it; a per-row lease is what it already had.
 *
 * So the lease names the chain — `jobs.ts` enqueues `chain.dispense` keyed `ember:testnet`, one row
 * for every replica to contend over — and `dispenses_in_flight_uniq` in the schema is the same
 * statement made by the database, for the case where the lease has already failed: a clock skew
 * past `locked_until`, a handler that outran its lease, an operator running a script beside the
 * workers.
 *
 * The frozen service's answer to this is `Sender._serialise` (`stack/repos/hearth/tools/faucet/
 * src/sender.js`), one promise chain in one process. Its header is exactly right about the
 * problem — "ask it twice before the first transaction reaches the mempool and it answers the same
 * number twice; the second transaction then replaces the first instead of following it, and one of
 * the two users never gets paid" — and its solution is a module-scope variable, which the second
 * replica cannot see.
 *
 * ## The order of operations, which is the other half
 *
 *     claim the row → read the nonce → ask custody → **COMMIT THE BYTES** → broadcast
 *
 * A crash before the commit has broadcast nothing: the signature is discarded UNBROADCAST and the
 * next tick starts again from a fresh nonce read. A crash after it leaves a `signed` row with
 * `raw_tx` populated, and `advance` RESUMES AT BROADCAST — there is no path anywhere in this file
 * from `signed` back to `queued`, so one dispense can never be signed twice.
 *
 * **That is what makes a lost broadcast response safe.** Re-broadcasting the SAME committed bytes
 * is not a second transaction: same nonce, same signature, same hash. The node either takes it or
 * says it already has it, and `AlreadyKnownError` reads the second as the success it is
 * (`rpc.ts`). What would send twice is signing again — which requires reading the nonce again,
 * which requires reaching `start`, which a `signed` row cannot do.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Db, Tx } from './db.ts'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { keccak256 } from './keccak.ts'
import { addressKey, sameAddress, toChecksumAddress } from './address.ts'
import { release, type LimitConfig } from './limits.ts'
import {
  AlreadyKnownError,
  RpcError,
  RpcUnavailableError,
  type Rpc,
} from './rpc.ts'
import {
  CustodySignRefusedError,
  CustodyUnavailableError,
  type CustodyClient,
  type UnsignedDrip,
} from './custodyclient.ts'

/**
 * Gas for a plain native-value transfer: the EIP intrinsic cost, exactly.
 *
 * Fixed rather than estimated, and that is correctness rather than a saving. A transfer with empty
 * calldata to an account with no code costs exactly 21,000 gas — there is no case in which it costs
 * more, so an estimate can only introduce a number that is wrong. Custody's `assertTransfer`
 * requires `[21_000, 200_000]` (`custody/src/signing.ts`), which this sits at the floor of.
 */
export const TRANSFER_GAS = 21_000

export interface DispenseRow {
  readonly id: string
  readonly recipient: string
  readonly requester: string
  readonly status: string
  readonly amountWei: bigint
  readonly nonce: number | null
  readonly rawTx: string | null
  readonly txHash: string | null
  readonly attempts: number
}

export interface DispenseDeps {
  readonly sql: Db
  readonly rpc: Rpc
  readonly custody: CustodyClient
  readonly logger: Logger
  readonly metrics: Metrics
  readonly fundingAddress: string
  readonly chainId: number
  readonly confirmations: number
  readonly gasPriceWei: bigint
  readonly limits: LimitConfig
  readonly maxRecipientBalanceWei: bigint
  readonly reserveWei: bigint
}

/** What one tick did. Returned so the job can log it and a test can assert on it. */
export interface DriveResult {
  readonly advanced: string | null
  readonly started: string | null
  readonly retired: readonly string[]
}

/** How many rows one tick will retire before giving the chain back. */
const MAX_RETIREMENTS_PER_TICK = 25

/**
 * One step for the chain. **Call this only from a handler holding the `ember:testnet` lease.**
 *
 * A tick advances the in-flight dispense and then, only if nothing is in flight, starts the oldest
 * queued one. It may move past a queued row only when that row was RETIRED having signed nothing —
 * a permanent refusal, released from `queued`. That is safe for exactly the reason settlement gives:
 * nothing was signed, no nonce was read, the funding address is exactly as it was found, and the
 * serial rule is not being broken. Anything that signed is this chain's turn used up.
 */
export async function driveChain(
  deps: DispenseDeps,
  heartbeat: () => Promise<boolean> = async () => true,
): Promise<DriveResult> {
  const retired: string[] = []
  let advanced: string | null = null

  const inFlight = await inFlightDispense(deps.sql, deps.chainId)
  if (inFlight) {
    await advance(deps, inFlight)
    advanced = inFlight.id
    await heartbeat()
    // Whatever `advance` concluded, RE-READ rather than reasoning about it: it may have confirmed,
    // failed, or simply moved a confirmation count, and only the database knows which.
    if (await inFlightDispense(deps.sql, deps.chainId)) {
      return { advanced, started: null, retired }
    }
  }

  for (let i = 0; i < MAX_RETIREMENTS_PER_TICK; i += 1) {
    const queued = await nextQueued(deps.sql, deps.chainId)
    if (!queued) break
    const outcome = await start(deps, queued)
    await heartbeat()
    if (outcome === 'signed') return { advanced, started: queued.id, retired }
    if (outcome === 'held') return { advanced, started: null, retired }
    // 'retired': the row was refused from `queued` having signed nothing, so the chain is exactly
    // as it was found and the next queued row may have this tick. Without this, a queue whose head
    // can never be built clears one row per poll and fifty such rows take an hour.
    retired.push(queued.id)
  }

  return { advanced, started: null, retired }
}

/* ------------------------------------------------------------------ starting */

type StartOutcome = 'signed' | 'held' | 'retired'

/**
 * Read the nonce, ask custody, COMMIT and broadcast one queued dispense.
 *
 * `held` is returned whenever the chain's turn is used up without a retirement — the claim was
 * lost, custody was unreachable, the node would not answer. The row stays `queued` and the next
 * tick tries again from a fresh nonce read, which is the only safe recovery from "we do not know".
 */
async function start(deps: DispenseDeps, row: DispenseRow): Promise<StartOutcome> {
  // THE CLAIM. False means either the state moved under us or `dispenses_in_flight_uniq` refused
  // because something else on this chain is already in flight. Both mean "not my turn", and the
  // second is the index doing the job the lease was supposed to have already done.
  if (!(await claimForSigning(deps.sql, row.id))) return 'held'

  /* ── The two reads that must happen before anything is signed ──────────────────────────────
   *
   * Both are here rather than at acceptance time, deliberately. A balance checked when the request
   * was queued is a balance from before every dispense that has run since, and a recipient balance
   * checked then is one the recipient has had time to change. The check that matters is the one
   * taken immediately before the signature.
   */
  let refusal: string | null = null
  try {
    const funding = await deps.rpc.getBalance(deps.fundingAddress)
    const needed = row.amountWei + BigInt(TRANSFER_GAS) * deps.gasPriceWei + deps.reserveWei
    if (funding < needed) {
      // NOT a refusal of this dispense — the faucet is dry, which is an operator's problem and not
      // this recipient's. Held, so the row waits for a top-up rather than being failed and having
      // its reservation released to somebody else.
      deps.metrics.set('faucet_dry', 1)
      deps.logger.warn('the faucet is out of EMBER; holding the queue until it is funded', {
        fundingAddress: deps.fundingAddress,
        balanceWei: funding.toString(10),
        neededWei: needed.toString(10),
      })
      await releaseToQueued(deps.sql, row.id)
      return 'held'
    }
    deps.metrics.set('faucet_dry', 0)

    // The recipient-balance ceiling. Zero disables it: an operator running a devnet where every
    // account is pre-funded has no use for the rule, and `env.ts` refuses a non-zero value below
    // one drip so the rule can never bar everybody it has already funded.
    if (deps.maxRecipientBalanceWei > 0n) {
      const held = await deps.rpc.getBalance(row.recipient)
      if (held >= deps.maxRecipientBalanceWei) {
        refusal =
          `that address already holds ${held.toString(10)} wei; the faucet funds accounts below ` +
          `${deps.maxRecipientBalanceWei.toString(10)} wei`
      }
    }
  } catch (err) {
    if (err instanceof RpcUnavailableError || err instanceof RpcError) {
      deps.logger.warn('the node could not be read before signing; holding', { err })
      await releaseToQueued(deps.sql, row.id)
      return 'held'
    }
    throw err
  }

  if (refusal) {
    await retire(deps, row, refusal)
    return 'retired'
  }

  /* ── The nonce, then the signature ─────────────────────────────────────────────────────── */

  let unsigned: UnsignedDrip
  try {
    const nonce = await deps.rpc.getNonce(deps.fundingAddress, 'pending')
    unsigned = {
      // THE CHECKSUMMED FORM, not the lower-cased one the column stores.
      //
      // Functionally either would pass: custody's transfer shape only requires
      // `ethers.isAddress(to)` (`custody/src/signing.ts`), which accepts all-lowercase, and
      // EIP-55 is a display checksum rather than part of the address. It is sent checksummed
      // because the estate's convention at the custody boundary is the canonical form —
      // settlement passes an address it has put through `canonicaliseEvm` — and because custody's
      // SWEEP shape compares `to` against its pin CHARACTER FOR CHARACTER, with a refusal whose
      // message exists specifically for an address that differs only in case
      // (`custody/src/signing.ts`). A service that sent a different spelling from every
      // other caller would be the one that discovered that the day a shape gained a comparison.
      to: toChecksumAddress(row.recipient),
      // A decimal string, never a number: 1e18 wei does not fit a double, and custody refuses a
      // non-safe-integer rather than rounding it.
      value: row.amountWei.toString(10),
      gasLimit: TRANSFER_GAS,
      gasPrice: deps.gasPriceWei.toString(10),
      nonce,
      chainId: deps.chainId,
      type: 0,
      data: '0x',
    }
  } catch (err) {
    deps.logger.warn('could not read the nonce; holding', { err })
    await releaseToQueued(deps.sql, row.id)
    return 'held'
  }

  let signedTx: string
  let auditId: string
  try {
    const result = await deps.custody.sign({ payload: unsigned, correlationId: row.id })
    signedTx = result.signedTx
    auditId = result.auditId
  } catch (err) {
    if (err instanceof CustodySignRefusedError) {
      // Custody LOOKED at it and said no. Permanent for this request, and nothing was signed — so
      // this is the one signing failure it is safe to retire and refund from.
      deps.metrics.increment('faucet_custody_refusals_total', { code: err.code })
      await retire(deps, row, `custody refused the signature (${err.code})`)
      return 'retired'
    }
    if (err instanceof CustodyUnavailableError) {
      // We do not know whether it signed. Nothing was BROADCAST either way — that is the whole
      // reason the commit sits after this call and before the broadcast — so the safe move is to
      // discard whatever may exist unbroadcast and start again from a fresh nonce next tick.
      deps.logger.warn('custody was unavailable; the signature (if any) is discarded unbroadcast', { err })
      await releaseToQueued(deps.sql, row.id)
      return 'held'
    }
    throw err
  }

  /* ── THE COMMIT. Everything above this line can be safely repeated; nothing below it can. ── */

  const hash = transactionHash(signedTx)
  if (!(await markSigned(deps.sql, row.id, { nonce: unsigned.nonce, rawTx: signedTx, txHash: hash, auditId }))) {
    // Somebody else committed a signature for this row first. Ours is discarded UNBROADCAST, which
    // costs a signature and moves nothing — the strictly safe direction. Broadcasting it would be
    // the double-spend this file exists to prevent.
    deps.logger.warn('another worker committed a signature for this dispense; discarding ours unbroadcast', {
      dispenseId: row.id,
    })
    return 'held'
  }

  await broadcast(deps, { ...row, nonce: unsigned.nonce, rawTx: signedTx, txHash: hash, status: 'signed' })
  return 'signed'
}

/* ------------------------------------------------------------------ advancing */

/** Move the in-flight dispense one step: broadcast it if it has not been, else look for a receipt. */
async function advance(deps: DispenseDeps, row: DispenseRow): Promise<void> {
  if (row.status === 'signing') {
    // A `signing` row is one whose worker died between the claim and the commit. Nothing was
    // signed — the commit is what makes a signature exist as far as this service is concerned — so
    // it goes back to `queued` and the next tick starts it over from a fresh nonce.
    await releaseToQueued(deps.sql, row.id)
    return
  }
  if (row.status === 'signed') {
    // RESUMED AT BROADCAST. The bytes are committed, so this is the same transaction it always
    // was: same nonce, same signature, same hash.
    await broadcast(deps, row)
    return
  }
  await track(deps, row)
}

/**
 * Broadcast committed bytes, and treat "the node already has this" as the success it is.
 *
 * This function is safe to call any number of times for one row. That is not a comment, it is the
 * requirement: the crash window between `markSigned` and `markBroadcast` is real, and the recovery
 * from it is to call this again with the identical bytes.
 */
async function broadcast(deps: DispenseDeps, row: DispenseRow): Promise<void> {
  if (!row.rawTx || !row.txHash) {
    // Unreachable while `dispenses_signed_has_bytes` holds. Checked anyway, because the alternative
    // to a throw here is a silent no-op that leaves a row in `signed` for ever.
    throw new Error(`dispense ${row.id} is ${row.status} with no committed bytes`)
  }
  try {
    const returned = await deps.rpc.sendRawTransaction(row.rawTx)
    if (returned !== row.txHash) {
      // The node knows this transaction by a different hash from the one we derived from the bytes
      // it was given. One of the two encodings is wrong, and continuing would mean polling for a
      // receipt that will never arrive under a hash nothing on chain has.
      deps.logger.error('the node returned a different transaction hash from the one we derived', {
        dispenseId: row.id,
        derived: row.txHash,
        returned,
      })
    }
    await markBroadcast(deps.sql, row.id)
    deps.metrics.increment('faucet_dispenses_broadcast_total')
  } catch (err) {
    if (err instanceof AlreadyKnownError) {
      // **THE EXACTLY-ONCE PATH.** The node already holds these exact bytes, which means a previous
      // attempt's broadcast reached it and only the RESPONSE was lost. Nothing is sent, nothing is
      // signed, and the row moves to `broadcast` so the next tick goes looking for the receipt.
      deps.logger.info('the node already holds this transaction; the earlier broadcast landed', {
        dispenseId: row.id,
        txHash: row.txHash,
      })
      deps.metrics.increment('faucet_rebroadcasts_deduped_total')
      await markBroadcast(deps.sql, row.id)
      return
    }
    if (err instanceof RpcError) {
      // The node LOOKED at the transaction and refused it — a malformed encoding, an
      // underpriced fee, an intrinsic gas failure. Permanent for these bytes. The row is failed,
      // and it is failed WITHOUT releasing the reservation, because a transaction that was handed
      // to a node may have been gossiped before it was refused. That is the conservative
      // direction: the cost of being wrong here is one drip's worth of budget, and the cost of
      // being wrong the other way is a double-spend.
      deps.logger.error('the node refused the transaction', { dispenseId: row.id, err })
      await markFailed(deps.sql, row.id, `the node refused the transaction: ${err.message}`)
      deps.metrics.increment('faucet_dispenses_failed_total', { reason: 'rejected' })
      return
    }
    // Unreachable, unknown, or the node is down. Leave the row exactly where it is; the next tick
    // re-broadcasts the same bytes, which is a no-op if the first one landed after all.
    deps.logger.warn('broadcast could not be completed; the bytes stand and will be re-sent', {
      dispenseId: row.id,
      err,
    })
  }
}

/** Poll for the receipt and count confirmations up to the pinned depth. */
async function track(deps: DispenseDeps, row: DispenseRow): Promise<void> {
  if (!row.txHash) throw new Error(`dispense ${row.id} is broadcast with no transaction hash`)
  let receipt: Awaited<ReturnType<Rpc['getTransactionReceipt']>>
  let head: bigint
  try {
    receipt = await deps.rpc.getTransactionReceipt(row.txHash)
    // Null is an ANSWER — the transaction is still in the mempool — and not a fault. Nothing to do
    // but come back next tick; the bytes are on the row and the node has them.
    if (!receipt) return
    head = await deps.rpc.blockNumber()
  } catch (err) {
    deps.logger.warn('could not read the receipt; will retry', { dispenseId: row.id, err })
    return
  }

  if (!receipt.status) {
    // A reverted plain value transfer is not a user error — a transfer to an EOA cannot revert —
    // so this is a chain fault worth an operator's attention. The reservation is NOT released: the
    // gas was spent and the nonce consumed.
    await markFailed(deps.sql, row.id, 'the transaction reverted on chain')
    deps.metrics.increment('faucet_dispenses_failed_total', { reason: 'reverted' })
    return
  }

  const depth = head >= receipt.blockNumber ? Number(head - receipt.blockNumber) + 1 : 1
  if (depth < deps.confirmations) {
    await markConfirmations(deps.sql, row.id, depth, receipt.blockNumber)
    return
  }
  await markConfirmed(deps.sql, row.id, depth, receipt.blockNumber)
  deps.metrics.increment('faucet_dispenses_confirmed_total')
  deps.logger.info('dispensed', {
    dispenseId: row.id,
    to: row.recipient,
    amountWei: row.amountWei.toString(10),
    txHash: row.txHash,
    blockNumber: receipt.blockNumber.toString(10),
  })
}

/* ------------------------------------------------------------------ retirement */

/**
 * Fail a dispense that signed NOTHING, and give its reservation back.
 *
 * The two halves are one transaction. A refusal that failed the row without releasing would charge
 * an honest user a day's cooldown for a rule they did not break; a release that failed to fail the
 * row would leave it queued for ever.
 */
async function retire(deps: DispenseDeps, row: DispenseRow, reason: string): Promise<void> {
  await deps.sql.begin(async (tx) => {
    await tx`
      update dispenses
         set status = 'failed', failure_reason = ${reason}, settled_at = now(), updated_at = now()
       where id = ${row.id}::uuid and status in ('queued','signing')
    `
    await release(tx as unknown as Tx, {
      recipient: row.recipient,
      requester: row.requester,
      amountWei: row.amountWei,
    })
  })
  deps.metrics.increment('faucet_dispenses_failed_total', { reason: 'refused' })
  deps.logger.info('dispense refused before signing; the reservation is released', {
    dispenseId: row.id,
    reason,
  })
}

/* ------------------------------------------------------------------ the hash */

/**
 * The transaction id of signed bytes: `keccak256(rawTx)`.
 *
 * DERIVED rather than remembered, which is what makes it available on the recovery path as well as
 * the happy one. A node answers a re-broadcast of a transaction it already holds with an ERROR
 * rather than with the hash, so a crash between broadcasting and recording would otherwise leave a
 * payment on chain that this service has no id to poll for.
 */
export function transactionHash(rawTx: string): string {
  const hex = rawTx.startsWith('0x') ? rawTx.slice(2) : rawTx
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('a signed transaction must be an even-length 0x-hex string')
  }
  return `0x${Buffer.from(keccak256(Buffer.from(hex, 'hex'))).toString('hex')}`
}

/* ------------------------------------------------------------------ the queries */

const COLUMNS = `id, recipient, requester, status, amount_wei, nonce, raw_tx, tx_hash`

interface RawRow {
  id: string
  recipient: string
  requester: string
  status: string
  amount_wei: string
  nonce: string | number | null
  raw_tx: string | null
  tx_hash: string | null
}

function toRow(raw: RawRow): DispenseRow {
  return {
    id: raw.id,
    recipient: raw.recipient,
    requester: raw.requester,
    status: raw.status,
    // `numeric` arrives as a string and `BigInt` parses it exactly. Never `Number(raw.amount_wei)`.
    amountWei: BigInt(raw.amount_wei),
    nonce: raw.nonce === null ? null : Number(raw.nonce),
    rawTx: raw.raw_tx,
    txHash: raw.tx_hash,
    attempts: 0,
  }
}

/** The one dispense holding the chain's nonce, if there is one. */
export async function inFlightDispense(sql: Db, chainId: number): Promise<DispenseRow | null> {
  const rows = (await sql`
    select ${sql.unsafe(COLUMNS)} from dispenses
     where chain_id = ${chainId} and status in ('signing','signed','broadcast')
     order by created_at
     limit 1
  `) as ReadonlyArray<RawRow>
  return rows[0] ? toRow(rows[0]) : null
}

/** The oldest queued dispense. FIFO, so a faucet under load is fair rather than arbitrary. */
export async function nextQueued(sql: Db, chainId: number): Promise<DispenseRow | null> {
  const rows = (await sql`
    select ${sql.unsafe(COLUMNS)} from dispenses
     where chain_id = ${chainId} and status = 'queued'
     order by created_at
     limit 1
  `) as ReadonlyArray<RawRow>
  return rows[0] ? toRow(rows[0]) : null
}

/**
 * Move `queued → signing`, or fail.
 *
 * False means one of two things and both mean "not my turn": the row moved under us, or
 * `dispenses_in_flight_uniq` refused because something else on this chain is already in flight.
 * The unique-violation is CAUGHT rather than allowed to propagate, because it is an expected
 * outcome of a correct race and not an error.
 */
export async function claimForSigning(sql: Db, id: string): Promise<boolean> {
  try {
    const result = await sql`
      update dispenses set status = 'signing', updated_at = now()
       where id = ${id}::uuid and status = 'queued'
    `
    return (result as unknown as { count?: number }).count === 1
  } catch (err) {
    if (isUniqueViolation(err)) return false
    throw err
  }
}

/** Back to `queued`, having signed nothing. The only path out of `signing` that is not terminal. */
export async function releaseToQueued(sql: Db, id: string): Promise<void> {
  await sql`
    update dispenses set status = 'queued', updated_at = now()
     where id = ${id}::uuid and status = 'signing'
  `
}

/**
 * **THE COMMIT.** `signing → signed`, with the bytes.
 *
 * Conditional on the row still being `signing`, so two workers that both got a signature — which
 * requires the lease AND the in-flight index to have both failed — cannot both commit. The loser
 * discards its bytes unbroadcast.
 */
export async function markSigned(
  sql: Db,
  id: string,
  input: { nonce: number; rawTx: string; txHash: string; auditId: string },
): Promise<boolean> {
  const result = await sql`
    update dispenses
       set status = 'signed', nonce = ${input.nonce}, raw_tx = ${input.rawTx},
           tx_hash = ${input.txHash}, custody_audit_id = ${input.auditId},
           signed_at = now(), updated_at = now()
     where id = ${id}::uuid and status = 'signing'
  `
  return (result as unknown as { count?: number }).count === 1
}

/** `signed → broadcast`. Idempotent: a row already `broadcast` stays there. */
export async function markBroadcast(sql: Db, id: string): Promise<void> {
  await sql`
    update dispenses
       set status = 'broadcast', broadcast_at = coalesce(broadcast_at, now()), updated_at = now()
     where id = ${id}::uuid and status in ('signed','broadcast')
  `
}

export async function markConfirmations(sql: Db, id: string, depth: number, block: bigint): Promise<void> {
  await sql`
    update dispenses
       set confirmations = ${depth}, block_number = ${block.toString(10)}, updated_at = now()
     where id = ${id}::uuid and status = 'broadcast'
  `
}

export async function markConfirmed(sql: Db, id: string, depth: number, block: bigint): Promise<void> {
  await sql`
    update dispenses
       set status = 'confirmed', confirmations = ${depth}, block_number = ${block.toString(10)},
           settled_at = now(), updated_at = now()
     where id = ${id}::uuid and status = 'broadcast'
  `
}

/** Terminal, and deliberately does NOT release: see the call sites for why each one does not. */
export async function markFailed(sql: Db, id: string, reason: string): Promise<void> {
  await sql`
    update dispenses
       set status = 'failed', failure_reason = ${reason}, settled_at = now(), updated_at = now()
     where id = ${id}::uuid and status <> 'confirmed'
  `
}

/** 23505 — a unique violation. An expected outcome of a correct race, not a fault. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
}

/** Exported for `server.ts`, which refuses a request naming the faucet's own funding address. */
export function isFundingAddress(deps: { readonly fundingAddress: string }, candidate: string): boolean {
  return sameAddress(deps.fundingAddress, candidate)
}

/** Exported for the reads. Lower-cased, because that is how the column stores it. */
export { addressKey }
