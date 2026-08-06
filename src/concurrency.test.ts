/**
 * **THE HEADLINE TESTS. Two workers on one chain: exactly one signs. Ten requests for one address:
 * exactly one is accepted.**
 *
 * These are the two defects the service exists to fix, reproduced against the real machinery and
 * then shown not to happen.
 *
 * ## The dispensing race
 *
 * The frozen faucet serialises sends with `Sender._serialise` — one promise chain in one process
 * (`stack/repos/hearth/tools/faucet/src/sender.js`). Its header is exactly right about the
 * problem: "ask it twice before the first transaction reaches the mempool and it answers the same
 * number twice; the second transaction then replaces the first instead of following it, and one of
 * the two users never gets paid". Its answer is a module-scope variable, which the second replica
 * cannot see. `settlement/src/worker.ts` records the same class of bug found in production
 * shape: **the contended resource is the chain's nonce, not the row.**
 *
 * There are two defences here and this file tests them SEPARATELY, because they fail separately:
 *
 *   1. **The lease**, keyed `ember:testnet`. `@cloudsforge/jobs` claims with `for update skip
 *      locked`, so of two workers polling for `chain.dispense / ember:testnet` exactly one gets it.
 *   2. **`dispenses_in_flight_uniq`**, a partial unique index over the states that hold a nonce. It
 *      is what stands when the lease has already failed — a clock skew past `locked_until`, a
 *      handler that outran its lease, an operator running a script beside the workers. The second
 *      test deletes the lease from the picture entirely and drives two workers straight at
 *      `driveChain`, which is the strictly harder case.
 *
 * The assertion in both is on `custody.signatures.length`, not on row states. A row state is what
 * this service believes; a signature is what actually happened to a nonce.
 *
 * ## The acceptance race
 *
 * Rule 1 of the brief: rate limits in the DATABASE, proved with concurrent requests. `limits.test.ts`
 * proves the reservation; this file proves it through the whole acceptance path, which is where a
 * second defence — `dispenses_live_recipient_uniq` — also has to hold.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type postgres from 'postgres'
import { driveChain } from './dispense.ts'
import { acceptDrip, DripRefusedError } from './requests.ts'
import { CHAIN_KEY, DISPENSE_KIND, registerHandlers } from './jobs.ts'
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
  quietLogger,
  resetFaucet,
  skip,
  testAddress,
  testLimits,
  testMetrics,
  testRequester,
  testRequesterKey,
} from './testsupport.ts'

describe('two replicas', { skip }, () => {
  let sql: postgres.Sql
  const ALICE = testAddress(0xa1)
  const BOB = testAddress(0xb0)
  const limits = testLimits()

  before(async () => {
    if (!enabled) return
    // A wide pool: every case here runs several transactions genuinely at once, and a pool of one
    // would serialise them by accident and prove nothing.
    sql = openDb(24)
    await migrateTestDb(sql)
  })

  after(async () => {
    if (enabled) await sql.end({ timeout: 5 })
  })

  beforeEach(async () => {
    if (enabled) await resetFaucet(sql)
  })

  const accept = (recipient: string, requester: string) =>
    acceptDrip(
      { sql: db(sql), chainId: TESTNET_CHAIN_ID, fundingAddress: FUNDING_ADDRESS, limits },
      { address: recipient, requester },
    )

  /**
   * Settle a dispense the way the worker would.
   *
   * The bytes and the hash are supplied because `dispenses_signed_has_bytes` requires them — a
   * `confirmed` row with no `raw_tx` is one this service could neither identify nor re-broadcast,
   * so the schema refuses it. The first version of this helper did not, and the constraint caught
   * it; it is left spelled out here rather than hidden behind a looser CHECK.
   */
  const settle = (id: string, nonce = 0) =>
    sql`
      update dispenses
         set status = 'confirmed', nonce = ${nonce}, raw_tx = ${`0x${'ab'.repeat(8)}`},
             tx_hash = ${`0x${nonce.toString(16).padStart(64, 'c')}`},
             block_number = 1, settled_at = now()
       where id = ${id}::uuid
    `

  /* ================================================================ dispensing */

  describe('never double-dispense', () => {
    /**
     * Two job runners with DIFFERENT owners, exactly as two replicas would be. One queue row,
     * keyed `ember:testnet`, is all there is for either of them to claim.
     */
    it('under the chain lease, exactly one of two runners signs', async () => {
      const node = fundedNode()
      const custody = fakeCustody()
      await accept(ALICE, testRequesterKey(1))
      await accept(BOB, testRequesterKey(2))

      const runners = ['replica-a', 'replica-b'].map((owner) => {
        const queue = new JobQueue(sql as unknown as JobsSql, { owner, leaseMs: 60_000 })
        const runner = new JobRunner({ queue, concurrency: 4, pollMs: 1_000 })
        registerHandlers(runner, {
          dispense: harness(sql, { node, custody, limits }),
          logger: quietLogger(),
          metrics: testMetrics(),
          retentionDays: 30,
          requester: testRequester(),
        })
        return { queue, runner }
      })

      await runners[0]!.queue.enqueue({ kind: DISPENSE_KIND, key: CHAIN_KEY, payload: {} })

      // Both tick at once. `for update skip locked` means one takes the row and the other skips.
      const claimed = await Promise.all(runners.map((r) => r.runner.tick()))

      assert.equal(
        claimed.reduce((a, b) => a + b, 0),
        1,
        'exactly one runner may claim the chain',
      )
      assert.equal(custody.signatures.length, 1, 'two signatures would be two transactions on one nonce')
      assert.equal(node.mempool.size, 1)
    })

    /**
     * **THE HARDER CASE. The lease is deleted from the picture entirely.**
     *
     * Two workers are driven straight at `driveChain` with no queue between them, which is what a
     * lease that has already failed looks like. Only the partial unique index stands, and it must
     * be enough.
     */
    it('with no lease at all, the schema still permits only one signature', async () => {
      const node = fundedNode()
      const custody = fakeCustody()
      await accept(ALICE, testRequesterKey(1))
      await accept(BOB, testRequesterKey(2))

      const workers = [harness(sql, { node, custody, limits }), harness(sql, { node, custody, limits })]
      const outcomes = await Promise.allSettled(workers.map((deps) => driveChain(deps)))

      // Neither worker may throw: losing the claim is an expected outcome of a correct race, not
      // an error, and a worker that crashed here would dead-letter the chain job.
      for (const outcome of outcomes) {
        assert.equal(outcome.status, 'fulfilled', `a worker threw: ${String((outcome as PromiseRejectedResult).reason)}`)
      }
      assert.equal(custody.signatures.length, 1, 'the in-flight index is the last line and it held')
      assert.equal(node.mempool.size, 1)

      const inFlight = (await sql`
        select count(*)::int as n from dispenses where status in ('signing','signed','broadcast')
      `) as ReadonlyArray<{ n: number }>
      assert.equal(inFlight[0]?.n, 1)
    })

    /** Four workers is not a different argument from two, but it is a better sample. */
    it('four workers at once still produce one signature', async () => {
      const node = fundedNode()
      const custody = fakeCustody()
      for (let i = 0; i < 4; i++) await accept(testAddress(0xc0 + i), testRequesterKey(0x100 + i))

      const workers = Array.from({ length: 4 }, () => harness(sql, { node, custody, limits }))
      await Promise.allSettled(workers.map((deps) => driveChain(deps)))

      assert.equal(custody.signatures.length, 1)
      assert.equal(node.mempool.size, 1)
    })

    /**
     * And across the whole queue, driven to completion by two workers ticking together: four
     * requests, four signatures, four DISTINCT nonces. A repeated nonce here would be the defect.
     */
    it('two workers draining a queue produce one signature per request, each on its own nonce', async () => {
      const node = fundedNode()
      const custody = fakeCustody()
      const ids: string[] = []
      for (let i = 0; i < 4; i++) ids.push((await accept(testAddress(0xd0 + i), testRequesterKey(0x100 + i))).id)

      const workers = [harness(sql, { node, custody, limits }), harness(sql, { node, custody, limits })]

      // Twenty rounds of both workers ticking simultaneously, mining whatever is in flight between
      // rounds so the queue can advance. Well more than the twelve ticks four requests need.
      let height = 1_000n
      for (let round = 0; round < 20; round++) {
        await Promise.allSettled(workers.map((deps) => driveChain(deps)))
        const last = node.broadcasts[node.broadcasts.length - 1]
        if (last) {
          node.mine(last, height)
          height += 5n
          node.setHeight(height)
        }
        // The fake node advances its own nonce only when asked to; do it here so each dispense
        // genuinely reads a new one, as a real node would after a transaction is mined.
        node.setNonce(FUNDING_ADDRESS, custody.signatures.length)
      }

      assert.equal(custody.signatures.length, 4, 'one signature per request, no more and no fewer')
      const nonces = custody.signatures.map((s) => s.nonce)
      assert.equal(new Set(nonces).size, 4, `two transactions shared a nonce: ${nonces.join(', ')}`)

      const settled = (await sql`
        select count(*)::int as n from dispenses where status = 'confirmed'
      `) as ReadonlyArray<{ n: number }>
      assert.equal(settled[0]?.n, 4)
    })
  })

  /* ================================================================ acceptance */

  describe('never accept two live requests for one address', () => {
    /**
     * **RULE 1 OF THE BRIEF, PROVED THROUGH THE WHOLE PATH.**
     *
     * Ten simultaneous requests for one address, each on its own transaction. The frozen limiter
     * would accept one per replica; here exactly one dispense may exist.
     */
    it('ten concurrent requests for one address create exactly one dispense', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_v, i) => accept(ALICE, testRequesterKey(0x100 + i))),
      )

      const accepted = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof accept>>> =>
          r.status === 'fulfilled' && !r.value.duplicate,
      )
      assert.equal(accepted.length, 1, `expected one acceptance, got ${accepted.length}`)

      // Everything else must be a clean refusal, never a 500. A caller that got an unhandled
      // driver error would be a caller told to retry a request that in fact succeeded.
      for (const result of results) {
        if (result.status === 'rejected') {
          assert.ok(
            result.reason instanceof DripRefusedError,
            `a losing request failed with something other than a refusal: ${String(result.reason)}`,
          )
        }
      }

      const rows = (await sql`select count(*)::int as n from dispenses`) as ReadonlyArray<{ n: number }>
      assert.equal(rows[0]?.n, 1, 'one address, one dispense')

      // And exactly one drip of budget was consumed — the nine losers rolled back.
      const state = await budgetState(sql as unknown as Db, limits)
      assert.equal(state.spentWei, limits.dripWei)
    })

    /**
     * The same ten requests, but every one of them carries the SAME idempotency key — a client
     * retrying a request whose response it never saw. Every caller must get the same dispense id,
     * and none may be refused: a retry is not a rate-limit violation.
     */
    it('ten concurrent retries of one request all answer with the same dispense', async () => {
      const key = 'client-idempotency-key-1'
      const retry = () =>
        acceptDrip(
          { sql: db(sql), chainId: TESTNET_CHAIN_ID, fundingAddress: FUNDING_ADDRESS, limits },
          { address: ALICE, requester: testRequesterKey(1), idempotencyKey: key },
        )

      const results = await Promise.allSettled(Array.from({ length: 10 }, retry))
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof retry>>> => r.status === 'fulfilled',
      )
      assert.equal(fulfilled.length, 10, 'a retry is not a rate-limit violation')

      const ids = new Set(fulfilled.map((r) => r.value.id))
      assert.equal(ids.size, 1, 'every retry must be answered with the one dispense')
      assert.equal(fulfilled.filter((r) => !r.value.duplicate).length, 1, 'exactly one was the original')

      const rows = (await sql`select count(*)::int as n from dispenses`) as ReadonlyArray<{ n: number }>
      assert.equal(rows[0]?.n, 1)
      const state = await budgetState(sql as unknown as Db, limits)
      assert.equal(state.spentWei, limits.dripWei, 'nine retries consumed no budget')
    })

    /**
     * Twenty concurrent requests for twenty different addresses against a budget of five drips.
     * Nothing here is a duplicate, so the only thing that can bound it is the budget — and it must,
     * exactly.
     */
    it('twenty concurrent requests cannot exceed the budget', async () => {
      const small = testLimits({ budgetWei: 50n * ONE_EMBER, dripWei: 10n * ONE_EMBER, requesterLimit: 1_000 })
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_v, i) =>
          acceptDrip(
            { sql: db(sql), chainId: TESTNET_CHAIN_ID, fundingAddress: FUNDING_ADDRESS, limits: small },
            { address: testAddress(0xe000 + i), requester: testRequesterKey(1) },
          ),
        ),
      )
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5)
      const state = await budgetState(sql as unknown as Db, small)
      assert.ok(state.spentWei <= state.capWei)
      assert.equal(state.spentWei, 50n * ONE_EMBER)
    })

    /**
     * The second defence, in isolation: a request for an address that already has a LIVE dispense
     * is refused even when its cooldown row has been cleared. That is the case the cooldown alone
     * cannot cover, because the cooldown row only settles the second request once the first has
     * committed.
     */
    it('the schema refuses a second live dispense for one address', async () => {
      const first = await accept(ALICE, testRequesterKey(1))
      assert.equal(first.duplicate, false)
      await sql`delete from faucet_address_grants`

      await assert.rejects(
        sql`
          insert into dispenses (recipient, requester, status, amount_wei, chain_id, fingerprint)
          values (${ALICE.toLowerCase()}, ${testRequesterKey(2)}, 'queued', ${limits.dripWei.toString(10)}::numeric,
                  ${TESTNET_CHAIN_ID}, 'a-different-fingerprint')
        `,
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, '23505')
          assert.match(String((err as { constraint_name?: string }).constraint_name), /live_recipient_uniq/)
          return true
        },
      )
    })

    /**
     * `dispenses_live_recipient_uniq` covers the LIVE states only, so a settled dispense stops
     * blocking its address. The second request carries its own idempotency key, because that is
     * what makes it a genuinely new request rather than a retry of the first — without one, both
     * fall in the same cooldown bucket, fingerprint identically, and the second is correctly
     * answered with the first's dispense.
     */
    it('a settled dispense stops being live, so the address can be served again', async () => {
      const fresh = (key: string) =>
        acceptDrip(
          { sql: db(sql), chainId: TESTNET_CHAIN_ID, fundingAddress: FUNDING_ADDRESS, limits },
          { address: ALICE, requester: testRequesterKey(1), idempotencyKey: key },
        )
      const first = await fresh('day-one')
      await settle(first.id)
      // The cooldown has passed; the live-recipient index is the only thing left that could refuse.
      await sql`delete from faucet_address_grants`

      const second = await fresh('day-two')
      assert.equal(second.duplicate, false)
      assert.notEqual(second.id, first.id)
    })

    /**
     * And the converse, which is the property that makes the default key safe: two keyless requests
     * inside one cooldown are ONE request, answered with one dispense, however the grant rows look.
     */
    it('two keyless requests inside one cooldown are one request', async () => {
      const first = await accept(ALICE, testRequesterKey(1))
      await settle(first.id)
      await sql`delete from faucet_address_grants`
      const second = await accept(ALICE, testRequesterKey(2))
      assert.equal(second.duplicate, true)
      assert.equal(second.id, first.id)
    })
  })
})
