/**
 * The dispense state machine: the ladder, the recovery paths, and **exactly-once**.
 *
 * The concurrency proofs are in `concurrency.test.ts`. This file is about what one worker does,
 * and the cases that matter are the ones where something goes wrong between the signature and the
 * broadcast — because that is the window in which a faucet sends twice.
 *
 * Every assertion about whether money moved is on `custody.signatures.length` or on
 * `node.broadcasts`, never on a row state. A row state is what this service BELIEVES; a signature
 * is what actually happened to a nonce.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import { driveChain, transactionHash, TRANSFER_GAS } from './dispense.ts'
import { acceptDrip } from './requests.ts'
import { budgetState } from './limits.ts'
import type { Db } from './db.ts'
import {
  FUNDING_ADDRESS,
  ONE_EMBER,
  TESTNET_CHAIN_ID,
  db,
  enabled,
  fakeCustody,
  fundedNode,
  harness,
  migrateTestDb,
  openDb,
  readRow,
  resetFaucet,
  skip,
  testAddress,
  testLimits,
  testRequesterKey,
  type FakeCustody,
  type FakeNode,
} from './testsupport.ts'

describe('dispensing', { skip }, () => {
  let sql: postgres.Sql
  const ALICE = testAddress(0xa1)
  const BOB = testAddress(0xb0)

  before(async () => {
    if (!enabled) return
    sql = openDb(8)
    await migrateTestDb(sql)
  })

  after(async () => {
    if (enabled) await sql.end({ timeout: 5 })
  })

  beforeEach(async () => {
    if (enabled) await resetFaucet(sql)
  })

  const limits = testLimits()

  /** Queue one request through the real acceptance path. */
  async function queue(recipient: string, requester = testRequesterKey(7)): Promise<string> {
    const accepted = await acceptDrip(
      { sql: db(sql), chainId: TESTNET_CHAIN_ID, fundingAddress: FUNDING_ADDRESS, limits },
      { address: recipient, requester },
    )
    return accepted.id
  }

  function rig(overrides: { node?: FakeNode; custody?: FakeCustody } = {}) {
    const node = overrides.node ?? fundedNode()
    const custody = overrides.custody ?? fakeCustody()
    return { node, custody, deps: harness(sql, { node, custody, limits }) }
  }

  /* ---------------------------------------------------------------- the happy ladder */

  describe('the ladder', () => {
    it('signs, broadcasts and then confirms one queued request', async () => {
      const { node, custody, deps } = rig()
      const id = await queue(ALICE)

      // Tick one: nothing in flight, so the queued row is started — signed and broadcast.
      const first = await driveChain(deps)
      assert.equal(first.started, id)
      assert.equal(custody.signatures.length, 1)
      assert.equal((await readRow(sql, id))?.status, 'broadcast')

      // Tick two: a receipt exists but only at depth 1, and the harness requires 2.
      node.mine(node.broadcasts[0]!, 1_000n)
      node.setHeight(1_000n)
      await driveChain(deps)
      const partway = await readRow(sql, id)
      assert.equal(partway?.status, 'broadcast')
      assert.equal(partway?.confirmations, 1)

      // Tick three: the head moves on and the depth is reached.
      node.setHeight(1_001n)
      await driveChain(deps)
      assert.equal((await readRow(sql, id))?.status, 'confirmed')

      // One request, one signature, one broadcast.
      assert.equal(custody.signatures.length, 1)
      assert.equal(node.broadcasts.length, 1)
    })

    it('asks custody for exactly the shape its treasury policy accepts', async () => {
      const { custody, deps } = rig()
      await queue(ALICE)
      await driveChain(deps)

      const payload = custody.signatures[0]!
      // Every one of these is a rule in `custody/src/signing.ts`. A mismatch is a 403 that
      // does not say which field was wrong, so getting them right by construction is the only way.
      assert.equal(payload.to, ALICE)
      assert.equal(payload.data, '0x', 'calldata must be empty — with it, this is a contract call')
      assert.equal(payload.gasLimit, TRANSFER_GAS)
      assert.equal(payload.gasLimit, 21_000)
      assert.equal(payload.type, 0, 'Ember v1 has no type-2 decoder')
      assert.equal(payload.chainId, TESTNET_CHAIN_ID)
      assert.equal(typeof payload.value, 'string', 'a wei amount must not cross as a JSON number')
      assert.equal(payload.value, (10n * ONE_EMBER).toString(10))
      assert.equal(typeof payload.gasPrice, 'string')
      assert.equal(Number.isSafeInteger(payload.nonce), true)
    })

    it('signs FIFO, so a faucet under load is fair rather than arbitrary', async () => {
      const { custody, deps } = rig()
      await queue(ALICE, testRequesterKey(1))
      await queue(BOB, testRequesterKey(2))
      await driveChain(deps)
      assert.equal(custody.signatures[0]?.to, ALICE)
    })

    it('advances the nonce it read from the node', async () => {
      const { node, custody, deps } = rig()
      node.setNonce(FUNDING_ADDRESS, 41)
      await queue(ALICE)
      await driveChain(deps)
      assert.equal(custody.signatures[0]?.nonce, 41)
      assert.equal((await readRow(sql, (await firstId(sql))!))?.nonce, 41)
    })
  })

  /* ---------------------------------------------------------------- exactly-once */

  describe('exactly once, when the broadcast response is lost', () => {
    /**
     * **RULE 3 OF THE BRIEF, PROVED.**
     *
     * The node TAKES the transaction and the response never arrives. The row is left in `signed`
     * with the bytes committed. On the next tick the worker must re-broadcast THE SAME BYTES —
     * same nonce, same signature, same hash — and must NOT ask custody for a second signature.
     *
     * The failure this prevents is the expensive one: signing again means reading the nonce again,
     * which produces a second transaction, at most one of which can be mined.
     */
    it('re-broadcasts the same bytes and never signs twice', async () => {
      const { node, custody, deps } = rig()
      const id = await queue(ALICE)

      node.loseNextResponse()
      await driveChain(deps)

      // The bytes are committed and the node HAS them, but this service does not know that.
      const afterLoss = await readRow(sql, id)
      assert.equal(afterLoss?.status, 'signed')
      assert.ok(afterLoss?.raw_tx, 'the bytes must be committed before the broadcast is attempted')
      assert.equal(custody.signatures.length, 1)
      assert.equal(node.mempool.size, 1, 'the node took the transaction')

      // The recovery tick. It resumes AT BROADCAST.
      await driveChain(deps)

      assert.equal(custody.signatures.length, 1, 'a second signature would be a second nonce read')
      assert.equal(node.mempool.size, 1, 'exactly one transaction exists on the node')
      assert.equal((await readRow(sql, id))?.status, 'broadcast')
      // Both broadcast attempts carried identical bytes, which is why the second was a no-op.
      assert.equal(node.broadcasts.length, 2)
      assert.equal(node.broadcasts[0], node.broadcasts[1])
    })

    it('survives the response being lost many times over', async () => {
      const { node, custody, deps } = rig()
      const id = await queue(ALICE)
      node.loseNextResponse()
      for (let i = 0; i < 6; i++) await driveChain(deps)
      assert.equal(custody.signatures.length, 1)
      assert.equal(node.mempool.size, 1)
      assert.equal((await readRow(sql, id))?.status, 'broadcast')
    })

    /**
     * A worker killed between the claim and the commit signed nothing as far as this service is
     * concerned — the commit is what makes a signature exist here — so the row goes back to
     * `queued` and starts over from a FRESH nonce read. That is the only safe recovery from "we
     * do not know", and it is safe precisely because nothing was broadcast.
     */
    it('a row stranded in signing goes back to queued and re-reads the nonce', async () => {
      const { node, custody, deps } = rig()
      const id = await queue(ALICE)
      // A worker that died between the claim and the commit leaves exactly this.
      await sql`update dispenses set status = 'signing', nonce = 5 where id = ${id}::uuid`

      node.setNonce(FUNDING_ADDRESS, 77)
      // ONE tick recovers it: `advance` returns it to `queued`, the re-read finds nothing in
      // flight, and the loop starts it properly. Deliberately not two — a stranded row costing a
      // whole poll interval would be a needless delay on the recovery path.
      await driveChain(deps)

      assert.equal(custody.signatures.length, 1, 'it was signed once, on the recovery tick')
      // THE POINT: a FRESH nonce read, not the 5 the dead worker had recorded. The commit is what
      // makes a signature exist here, and nothing was committed, so nothing is resumed.
      assert.equal(custody.signatures[0]?.nonce, 77)
      assert.equal((await readRow(sql, id))?.nonce, 77)
      assert.equal((await readRow(sql, id))?.status, 'broadcast')
    })

    /**
     * Custody may have signed and we may never learn it. Nothing was BROADCAST either way — that
     * is the entire reason the commit sits after the sign call and before the broadcast — so the
     * safe move is to discard whatever may exist, unbroadcast, and start again.
     */
    it('discards a signature whose response was lost, unbroadcast', async () => {
      const custody = fakeCustody()
      const { node, deps } = rig({ custody })
      const id = await queue(ALICE)

      custody.setUnavailable(true)
      await driveChain(deps)
      assert.equal((await readRow(sql, id))?.status, 'queued', 'the row must be retriable')
      assert.equal(node.broadcasts.length, 0, 'nothing may have been sent')

      custody.setUnavailable(false)
      await driveChain(deps)
      assert.equal((await readRow(sql, id))?.status, 'broadcast')
      assert.equal(node.mempool.size, 1)
    })

    it('the transaction hash is derived from the bytes, so it survives a lost response', () => {
      // A node answers a re-broadcast with an ERROR rather than with the hash, so a hash this
      // service did not derive is one it could not recover.
      const bytes = '0xdeadbeef'
      assert.equal(transactionHash(bytes), transactionHash(bytes))
      assert.match(transactionHash(bytes), /^0x[0-9a-f]{64}$/)
      assert.notEqual(transactionHash('0xdeadbeef'), transactionHash('0xdeadbeee'))
      assert.throws(() => transactionHash('0xabc'), /even-length/)
    })
  })

  /* ---------------------------------------------------------------- refusals */

  describe('what stops a dispense before it signs', () => {
    it('holds the whole queue when the faucet cannot cover a drip, rather than failing anybody', async () => {
      const { node, custody, deps } = rig()
      node.setBalance(FUNDING_ADDRESS, 1n)
      const id = await queue(ALICE)

      await driveChain(deps)
      assert.equal(custody.signatures.length, 0)
      // QUEUED, not failed. Being out of EMBER is an operator's problem, not this recipient's, and
      // failing the row would release its reservation to somebody else.
      assert.equal((await readRow(sql, id))?.status, 'queued')

      node.setBalance(FUNDING_ADDRESS, 10_000n * ONE_EMBER)
      await driveChain(deps)
      assert.equal((await readRow(sql, id))?.status, 'broadcast')
    })

    it('refuses a recipient who already holds the ceiling, and gives the reservation back', async () => {
      const node = fundedNode()
      const custody = fakeCustody()
      const deps = harness(sql, { node, custody, limits, maxRecipientBalanceWei: 100n * ONE_EMBER })
      node.setBalance(ALICE, 500n * ONE_EMBER)
      const id = await queue(ALICE)

      const result = await driveChain(deps)
      assert.deepEqual(result.retired, [id])
      assert.equal(custody.signatures.length, 0)
      const row = await readRow(sql, id)
      assert.equal(row?.status, 'failed')
      assert.match(row?.failure_reason ?? '', /already holds/)

      // The reservation is released: nothing was signed, so nothing was spent.
      const state = await budgetState(sql as unknown as Db, limits)
      assert.equal(state.spentWei, 0n)
      const grants = (await sql`select count(*)::int as n from faucet_address_grants`) as ReadonlyArray<{ n: number }>
      assert.equal(grants[0]?.n, 0)
    })

    it('a custody refusal is permanent and refunds, because nothing was signed', async () => {
      const custody = fakeCustody()
      const { deps } = rig({ custody })
      const id = await queue(ALICE)
      custody.refuse('binding_mismatch')

      await driveChain(deps)
      const row = await readRow(sql, id)
      assert.equal(row?.status, 'failed')
      assert.match(row?.failure_reason ?? '', /binding_mismatch/)
      const state = await budgetState(sql as unknown as Db, limits)
      assert.equal(state.spentWei, 0n)
    })

    /**
     * A node that LOOKED at the transaction and refused it is a permanent failure for those bytes
     * — but the reservation is deliberately NOT released, because a transaction handed to a node
     * may have been gossiped before it was refused. One drip of budget is the cost of being wrong
     * here; a double-spend is the cost of being wrong the other way.
     */
    it('a node rejection fails the row and does NOT refund', async () => {
      const { node, deps } = rig()
      const id = await queue(ALICE)
      node.refuseWith('intrinsic gas too low')

      await driveChain(deps)
      const row = await readRow(sql, id)
      assert.equal(row?.status, 'failed')
      assert.match(row?.failure_reason ?? '', /intrinsic gas too low/)
      const state = await budgetState(sql as unknown as Db, limits)
      assert.equal(state.spentWei, limits.dripWei, 'a broadcast that may have been gossiped is not refunded')
    })

    it('a reverted transaction is failed and is not refunded either', async () => {
      const { node, deps } = rig()
      const id = await queue(ALICE)
      await driveChain(deps)
      node.mine(node.broadcasts[0]!, 1_000n, false)
      await driveChain(deps)
      const row = await readRow(sql, id)
      assert.equal(row?.status, 'failed')
      assert.match(row?.failure_reason ?? '', /reverted/)
      const state = await budgetState(sql as unknown as Db, limits)
      assert.equal(state.spentWei, limits.dripWei)
    })

    it('an unreachable node holds rather than failing, and recovers by itself', async () => {
      const { node, custody, deps } = rig()
      const id = await queue(ALICE)
      node.setUnreachable(true)
      await driveChain(deps)
      assert.equal((await readRow(sql, id))?.status, 'queued')
      assert.equal(custody.signatures.length, 0)

      node.setUnreachable(false)
      await driveChain(deps)
      assert.equal((await readRow(sql, id))?.status, 'broadcast')
    })

    /**
     * A queue whose head can never be built must not clear one row per poll. A retired row signed
     * nothing, so the chain is exactly as it was found and the next row may have this tick.
     */
    it('walks past several retired rows in one tick', async () => {
      const node = fundedNode()
      const custody = fakeCustody()
      const deps = harness(sql, { node, custody, limits, maxRecipientBalanceWei: 1n })
      for (let i = 0; i < 4; i++) {
        node.setBalance(testAddress(0x900 + i), 500n * ONE_EMBER)
        await queue(testAddress(0x900 + i), testRequesterKey(0x100 + i))
      }
      const result = await driveChain(deps)
      assert.equal(result.retired.length, 4)
      assert.equal(custody.signatures.length, 0)
    })
  })

  /* ---------------------------------------------------------------- serialisation */

  /**
   * One in flight at a time, because the contended resource is the NONCE. A second queued request
   * waits, however long the first takes, and is served the moment the first settles.
   */
  describe('one transaction in flight at a time', () => {
    it('does not start a second dispense while one is in flight', async () => {
      const { node, custody, deps } = rig()
      const first = await queue(ALICE, testRequesterKey(1))
      const second = await queue(BOB, testRequesterKey(2))

      await driveChain(deps)
      assert.equal(custody.signatures.length, 1)
      assert.equal((await readRow(sql, second))?.status, 'queued')

      // Still in flight: no receipt yet.
      await driveChain(deps)
      assert.equal(custody.signatures.length, 1)

      // Settle the first, and only then does the second get its turn.
      node.mine(node.broadcasts[0]!, 1_000n)
      node.setHeight(1_010n)
      await driveChain(deps)
      assert.equal((await readRow(sql, first))?.status, 'confirmed')
      await driveChain(deps)
      assert.equal(custody.signatures.length, 2)
      assert.equal(custody.signatures[1]?.to, BOB)
    })

    /**
     * And the DATABASE says so too, for the case where the lease has already failed. Written
     * directly, as a second worker past its lease would.
     */
    it('the schema refuses a second in-flight dispense', async () => {
      const id = await queue(ALICE, testRequesterKey(1))
      const other = await queue(BOB, testRequesterKey(2))
      await sql`update dispenses set status = 'signing' where id = ${id}::uuid`
      await assert.rejects(
        sql`update dispenses set status = 'signing' where id = ${other}::uuid`,
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, '23505')
          assert.match(String((err as { constraint_name?: string }).constraint_name), /in_flight_uniq/)
          return true
        },
      )
    })

    it('the schema refuses a signed row with no bytes', async () => {
      const id = await queue(ALICE)
      await assert.rejects(
        sql`update dispenses set status = 'signed' where id = ${id}::uuid`,
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, '23514')
          assert.match(String((err as { constraint_name?: string }).constraint_name), /signed_has_bytes/)
          return true
        },
      )
    })
  })
})

async function firstId(sql: postgres.Sql): Promise<string | null> {
  const rows = (await sql`select id from dispenses order by created_at limit 1`) as ReadonlyArray<{ id: string }>
  return rows[0]?.id ?? null
}
