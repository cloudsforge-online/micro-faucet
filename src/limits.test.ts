/**
 * The limiter, against a real Postgres.
 *
 * **A fake database cannot prove any of this.** What is being tested is that two concurrent
 * transactions serialise on a row lock and that exactly one sees the pre-update value — which is a
 * property of Postgres, not of this code, and the only honest way to check it is to run it.
 *
 * The concurrency cases open a SEPARATE POOL CONNECTION per caller and start every transaction
 * before awaiting any of them. Running them on one connection would serialise them by accident and
 * the test would pass against a limiter that had no atomicity at all.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import { budgetState, release, reserve, type Reservation } from './limits.ts'
import type { Db, Tx } from './db.ts'
import {
  ONE_EMBER,
  enabled,
  migrateTestDb,
  openDb,
  resetFaucet,
  skip,
  testAddress,
  testLimits,
} from './testsupport.ts'

describe('the limits are the database', { skip }, () => {
  let sql: postgres.Sql
  const ALICE = testAddress(0xa1)
  const BOB = testAddress(0xb0)
  const IP = 'ip:203.0.113.7'

  before(async () => {
    if (!enabled) return
    sql = openDb(16)
    await migrateTestDb(sql)
  })

  after(async () => {
    if (enabled) await sql.end({ timeout: 5 })
  })

  beforeEach(async () => {
    if (enabled) await resetFaucet(sql)
  })

  /** One reservation, in its own transaction, as `acceptDrip` takes it. */
  const take = (
    recipient: string,
    requester = IP,
    config = testLimits(),
  ): Promise<Reservation> =>
    sql.begin(async (tx) => reserve(tx as unknown as Tx, { recipient, requester }, config)) as Promise<Reservation>

  /* ---------------------------------------------------------------- the address cooldown */

  describe('the per-address cooldown', () => {
    it('grants the first request and refuses the second', async () => {
      assert.deepEqual(await take(ALICE), { ok: true })
      const second = await take(ALICE, 'ip:different')
      assert.equal(second.ok, false)
      assert.equal(second.ok === false && second.code, 'address_cooldown')
    })

    it('serves a retry-after that is positive and inside the window', async () => {
      const config = testLimits({ addressCooldownSeconds: 600 })
      await take(ALICE, IP, config)
      const refusal = await take(ALICE, 'ip:different', config)
      assert.equal(refusal.ok, false)
      if (refusal.ok) return
      assert.ok(refusal.retryAfterSeconds > 0, 'retry-after must never be zero')
      assert.ok(refusal.retryAfterSeconds <= 600, 'retry-after must not exceed the window')
    })

    it('grants again once the cooldown has passed', async () => {
      await take(ALICE)
      // Move the grant into the past rather than sleeping. The cooldown is expressed against
      // now() in SQL, so this exercises the same comparison a real hour would.
      await sql`update faucet_address_grants set last_granted_at = now() - interval '2 hours'`
      assert.deepEqual(await take(ALICE), { ok: true })
      const [row] = (await sql`select grants from faucet_address_grants where recipient = ${ALICE.toLowerCase()}`) as ReadonlyArray<{ grants: string }>
      assert.equal(Number(row?.grants), 2, 'the second grant must increment rather than replace')
    })

    it('one address in two spellings is one address', async () => {
      assert.deepEqual(await take(ALICE.toLowerCase()), { ok: true })
      const second = await take(ALICE.toUpperCase().replace('0X', '0x'), 'ip:different')
      assert.equal(second.ok, false)
    })

    it('does not limit a different address', async () => {
      assert.deepEqual(await take(ALICE), { ok: true })
      assert.deepEqual(await take(BOB), { ok: true })
    })

    /**
     * **THE CONCURRENCY PROOF FOR THE COOLDOWN.** Ten simultaneous reservations for one address on
     * ten separate connections. Exactly one may win.
     *
     * This is the case the frozen limiter's `Map` cannot survive across replicas: its own atomicity
     * argument (`limits.js:20-25`) is sound and is about ONE process, and ten connections here
     * stand in for ten of them.
     */
    it('ten concurrent requests for one address grant exactly one', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => take(ALICE, 'ip:one')))
      const granted = results.filter((r) => r.ok)
      assert.equal(granted.length, 1, `expected exactly one grant, got ${granted.length}`)
      const [row] = (await sql`select grants from faucet_address_grants`) as ReadonlyArray<{ grants: string }>
      assert.equal(Number(row?.grants), 1)
    })
  })

  /* ---------------------------------------------------------------- the requester window */

  describe('the per-requester window', () => {
    it('grants up to the limit and then refuses', async () => {
      const config = testLimits({ requesterLimit: 3 })
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(await take(testAddress(0x100 + i), IP, config), { ok: true }, `grant ${i + 1}`)
      }
      const fourth = await take(testAddress(0x200), IP, config)
      assert.equal(fourth.ok, false)
      assert.equal(fourth.ok === false && fourth.code, 'requester_limit')
    })

    it('does not limit a different requester', async () => {
      const config = testLimits({ requesterLimit: 1 })
      assert.deepEqual(await take(ALICE, 'ip:one', config), { ok: true })
      assert.deepEqual(await take(BOB, 'ip:two', config), { ok: true })
    })

    it('resets when the window rolls', async () => {
      const config = testLimits({ requesterLimit: 1, requesterWindowSeconds: 60 })
      assert.deepEqual(await take(ALICE, IP, config), { ok: true })
      assert.equal((await take(BOB, IP, config)).ok, false)
      await sql`update faucet_requester_grants set window_started_at = now() - interval '2 minutes'`
      assert.deepEqual(await take(BOB, IP, config), { ok: true })
      const [row] = (await sql`select grants from faucet_requester_grants where requester = ${IP}`) as ReadonlyArray<{ grants: number }>
      assert.equal(Number(row?.grants), 1, 'a rolled window restarts the count at one')
    })

    /**
     * **THE CONCURRENCY PROOF FOR THE REQUESTER LIMIT.** Ten simultaneous requests from one
     * requester for ten DIFFERENT addresses — so the cooldown cannot be what refuses them.
     */
    it('ten concurrent requests from one requester grant exactly the limit', async () => {
      const config = testLimits({ requesterLimit: 3 })
      const results = await Promise.all(
        Array.from({ length: 10 }, (_v, i) => take(testAddress(0x300 + i), IP, config)),
      )
      assert.equal(results.filter((r) => r.ok).length, 3)
      const [row] = (await sql`select grants from faucet_requester_grants where requester = ${IP}`) as ReadonlyArray<{ grants: number }>
      assert.equal(Number(row?.grants), 3)
    })
  })

  /* ---------------------------------------------------------------- the budget */

  describe('the budget, which is the control that bounds the loss', () => {
    // Five drips' worth, one requester per address, so only the budget can refuse.
    const config = testLimits({
      dripWei: 10n * ONE_EMBER,
      budgetWei: 50n * ONE_EMBER,
      requesterLimit: 1_000,
    })

    it('refuses once the cap is reached, and says it is rate limited rather than dry', async () => {
      for (let i = 0; i < 5; i++) {
        assert.deepEqual(await take(testAddress(0x400 + i), IP, config), { ok: true }, `drip ${i + 1}`)
      }
      const sixth = await take(testAddress(0x500), IP, config)
      assert.equal(sixth.ok, false)
      if (sixth.ok) return
      assert.equal(sixth.code, 'budget_exhausted')
      // The wording is load-bearing: telling an operator "dry" when the balance is fine costs an
      // hour. The frozen service draws the same distinction (`limits.js:115-117`).
      assert.match(sixth.message, /rate limited, not empty/)
    })

    /**
     * **THE PROOF THAT MATTERS: THE CAP CANNOT BE EXCEEDED UNDER CONCURRENCY.**
     *
     * Twenty simultaneous requests, twenty different addresses, one budget of five drips. However
     * many win, the total spend must be at most the cap — and it must be exactly five, because a
     * partial grant is not a thing this limiter can produce.
     */
    it('twenty concurrent requests cannot spend more than the cap', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_v, i) => take(testAddress(0x600 + i), IP, config)),
      )
      const granted = results.filter((r) => r.ok).length
      assert.equal(granted, 5, `expected exactly five grants, got ${granted}`)

      const state = await budgetState(sql as unknown as Db, config)
      assert.equal(state.spentWei, 50n * ONE_EMBER)
      assert.equal(state.remainingWei, 0n)
      assert.ok(state.spentWei <= state.capWei, 'the spend must never exceed the cap')
    })

    /**
     * And the CHECK is the same statement made by the schema, for the case where some future write
     * path forgets the WHERE clause. Written directly, as an operator with psql would.
     */
    it('the schema refuses an over-cap spend even when the application does not', async () => {
      await take(ALICE, IP, config)
      await assert.rejects(
        sql`update faucet_budget set spent_wei = cap_wei + 1 where id = 1`,
        (err: unknown) => {
          // 23514 — a check constraint violation.
          assert.equal((err as { code?: string }).code, '23514')
          assert.match(String((err as { constraint_name?: string }).constraint_name), /within_cap/)
          return true
        },
      )
    })

    it('resets when the window rolls', async () => {
      for (let i = 0; i < 5; i++) await take(testAddress(0x700 + i), IP, config)
      assert.equal((await take(testAddress(0x800), IP, config)).ok, false)
      await sql`update faucet_budget set window_started_at = now() - interval '2 hours'`
      assert.deepEqual(await take(testAddress(0x800), IP, config), { ok: true })
      const state = await budgetState(sql as unknown as Db, config)
      assert.equal(state.spentWei, 10n * ONE_EMBER, 'a rolled window restarts the spend at one drip')
    })

    it('reports a full budget when the window has rolled but nothing has asked yet', async () => {
      await take(ALICE, IP, config)
      await sql`update faucet_budget set window_started_at = now() - interval '2 hours'`
      const state = await budgetState(sql as unknown as Db, config)
      // The stale spend must not be reported: it would show an exhausted faucet for as long as
      // nobody asked it for anything, and the next reservation resets it anyway.
      assert.equal(state.remainingWei, config.budgetWei)
    })

    it('every amount it reads back is a bigint, never a number', async () => {
      await take(ALICE, IP, config)
      const state = await budgetState(sql as unknown as Db, config)
      for (const value of [state.spentWei, state.capWei, state.remainingWei]) {
        assert.equal(typeof value, 'bigint')
      }
    })

    /**
     * numeric(78,0) rather than a Postgres `bigint`, which is 64 bits and holds 9.22e18 — nine and
     * a bit whole EMBER. A budget of ten EMBER would overflow it.
     */
    it('holds an amount a 64-bit column could not', async () => {
      const huge = testLimits({ dripWei: 10n ** 30n, budgetWei: 10n ** 40n, requesterLimit: 1_000 })
      assert.deepEqual(await take(ALICE, IP, huge), { ok: true })
      const state = await budgetState(sql as unknown as Db, huge)
      assert.equal(state.spentWei, 10n ** 30n)
      assert.ok(state.spentWei > BigInt(Number.MAX_SAFE_INTEGER))
    })
  })

  /* ---------------------------------------------------------------- release */

  describe('releasing a reservation that never left the building', () => {
    it('gives the address, the requester and the budget back', async () => {
      const config = testLimits()
      assert.deepEqual(await take(ALICE, IP, config), { ok: true })
      await sql.begin(async (tx) => {
        await release(tx as unknown as Tx, { recipient: ALICE, requester: IP, amountWei: config.dripWei })
      })
      // The address may ask again immediately: it was never funded.
      assert.deepEqual(await take(ALICE, IP, config), { ok: true })
      const state = await budgetState(sql as unknown as Db, config)
      assert.equal(state.spentWei, config.dripWei, 'the second grant is the only spend')
    })

    it('a double release cannot drive the spend below zero', async () => {
      const config = testLimits()
      await take(ALICE, IP, config)
      for (let i = 0; i < 3; i++) {
        await sql.begin(async (tx) => {
          await release(tx as unknown as Tx, { recipient: ALICE, requester: IP, amountWei: config.dripWei })
        })
      }
      const state = await budgetState(sql as unknown as Db, config)
      // `faucet_budget_nonneg` would abort the transaction on a bare subtraction, and a release is
      // a cleanup path that must not itself fail.
      assert.equal(state.spentWei, 0n)
    })
  })

  /* ---------------------------------------------------------------- all or nothing */

  /**
   * A request that passes the cooldown and then fails the budget must consume NEITHER. Otherwise
   * an address turned away by an exhausted budget would also be barred by a cooldown it never got
   * a drip from.
   */
  it('a request refused by a later limit consumes none of the earlier ones', async () => {
    const config = testLimits({ dripWei: 10n * ONE_EMBER, budgetWei: 10n * ONE_EMBER, requesterLimit: 1_000 })
    assert.deepEqual(await take(ALICE, IP, config), { ok: true })

    const refused = await take(BOB, IP, config)
    assert.equal(refused.ok === false && refused.code, 'budget_exhausted')

    // Bob's cooldown row must not exist: he was refused, not funded.
    const rows = (await sql`select recipient from faucet_address_grants order by recipient`) as ReadonlyArray<{ recipient: string }>
    assert.deepEqual(rows.map((r) => r.recipient), [ALICE.toLowerCase()])

    // And once the budget rolls, Bob is served immediately rather than waiting out a cooldown he
    // never earned.
    await sql`update faucet_budget set window_started_at = now() - interval '2 hours'`
    assert.deepEqual(await take(BOB, IP, config), { ok: true })
  })
})
