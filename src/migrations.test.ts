/**
 * The schema itself, and the leased jobs over it.
 *
 * The constraint tests write DIRECTLY, as an operator with psql or a future code path would. That
 * is the point of a constraint: it holds against writers that do not know about it, so proving it
 * through the application would prove the wrong thing.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import type postgres from 'postgres'
import { BASELINE_VERSION, IN_FLIGHT_STATES, LIVE_STATES, MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts'
import { CHAIN_KEY, DISPENSE_KIND, RECURRING, RETENTION_KIND, pruneSettled, registerHandlers, seedRecurring } from './jobs.ts'
import type { Db } from './db.ts'
import {
  FUNDING_ADDRESS,
  TESTNET_CHAIN_ID,
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
} from './testsupport.ts'

describe('the schema', { skip }, () => {
  let sql: postgres.Sql
  const ALICE = testAddress(0xa1)

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

  const insert = (overrides: Record<string, unknown> = {}) => {
    const row = {
      recipient: ALICE.toLowerCase(),
      requester: 'ip:test',
      status: 'queued',
      amount_wei: '10000000000000000000',
      chain_id: TESTNET_CHAIN_ID,
      fingerprint: `fp-${Math.random()}`,
      ...overrides,
    }
    return sql`insert into dispenses ${sql(row)} returning id` as unknown as Promise<ReadonlyArray<{ id: string }>>
  }

  /* ---------------------------------------------------------------- versioning */

  describe('versioning', () => {
    it('derives SCHEMA_VERSION from the migrations rather than restating it', () => {
      assert.equal(SCHEMA_VERSION, Math.max(...MIGRATIONS.map((m) => m.version)))
      assert.equal(BASELINE_VERSION, 0, 'the frozen service has no database to adopt')
    })

    it('has no duplicate versions', () => {
      assert.equal(new Set(MIGRATIONS.map((m) => m.version)).size, MIGRATIONS.length)
    })

    it('TABLES names every table the truncate must reach', async () => {
      const rows = (await sql`
        select tablename from pg_tables
         where schemaname = 'public' and tablename not in ('jobs','schema_migrations')
      `) as ReadonlyArray<{ tablename: string }>
      assert.deepEqual([...rows.map((r) => r.tablename)].sort(), [...TABLES].sort())
    })

    it('is idempotent — running it twice applies nothing the second time', async () => {
      await migrateTestDb(sql)
      await migrateTestDb(sql)
      const rows = (await sql`select count(*)::int as n from dispenses`) as ReadonlyArray<{ n: number }>
      assert.equal(rows[0]?.n, 0)
    })
  })

  /* ---------------------------------------------------------------- constraints */

  describe('the constraints hold against a writer that does not know about them', () => {
    it('refuses an amount that is not positive', async () => {
      await assert.rejects(insert({ amount_wei: '0' }), /amount_positive/)
      await assert.rejects(insert({ amount_wei: '-1' }), /amount_positive/)
    })

    it('refuses an unknown status', async () => {
      await assert.rejects(insert({ status: 'nearly' }), /status_known/)
    })

    it('refuses a recipient that is not lower-case hex', async () => {
      // The whole cooldown guarantee rests on one account having one spelling.
      await assert.rejects(insert({ recipient: ALICE }), /recipient_shape/)
      await assert.rejects(insert({ recipient: '0xshort' }), /recipient_shape/)
    })

    it('refuses a duplicate fingerprint', async () => {
      await insert({ fingerprint: 'the-same' })
      await sql`update dispenses set status = 'failed', failure_reason = 'x', settled_at = now()`
      await assert.rejects(insert({ fingerprint: 'the-same' }), /fingerprint_uniq/)
    })

    it('refuses a failed row with no reason', async () => {
      const [row] = await insert()
      await assert.rejects(sql`update dispenses set status = 'failed' where id = ${row!.id}::uuid`, /failed_has_reason/)
    })

    it('refuses a confirmed row with no block', async () => {
      const [row] = await insert()
      await assert.rejects(
        sql`update dispenses set status = 'confirmed', raw_tx = '0xab', tx_hash = ${`0x${'a'.repeat(64)}`}, nonce = 0 where id = ${row!.id}::uuid`,
        /confirmed_has_block/,
      )
    })

    it('refuses a transaction hash that is not 32 bytes of lower-case hex', async () => {
      const [row] = await insert()
      await assert.rejects(
        sql`update dispenses set tx_hash = '0xABC' where id = ${row!.id}::uuid`,
        /tx_hash_shape/,
      )
    })

    /**
     * `numeric(78,0)`, which is uint256's decimal width. A Postgres `bigint` is 64 bits and holds
     * 9.22e18 — nine and a bit whole EMBER at 18 decimals — so a budget of ten EMBER would
     * overflow it.
     */
    it('holds a uint256-width amount exactly, and returns it as a string', async () => {
      const huge = (2n ** 255n).toString(10)
      const [row] = await insert({ amount_wei: huge })
      const back = (await sql`select amount_wei from dispenses where id = ${row!.id}::uuid`) as ReadonlyArray<{ amount_wei: string }>
      assert.equal(typeof back[0]?.amount_wei, 'string', 'a numeric must not arrive as a double')
      assert.equal(BigInt(back[0]!.amount_wei), 2n ** 255n)
    })
  })

  /* ---------------------------------------------------------------- the two indexes */

  describe('the two partial unique indexes', () => {
    it('the live-recipient index covers exactly the live states', async () => {
      assert.deepEqual([...LIVE_STATES], ['queued', 'signing', 'signed', 'broadcast'])
      // A terminal row does not block its address; a live one does. Proved by moving one row
      // through every state and checking whether a second insert is permitted at each.
      const [first] = await insert({ fingerprint: 'first' })
      for (const status of ['queued', 'broadcast'] as const) {
        if (status === 'broadcast') {
          await sql`update dispenses set status = 'signing' where id = ${first!.id}::uuid`
          await sql`update dispenses set status = 'signed', raw_tx = '0xab', tx_hash = ${`0x${'a'.repeat(64)}`}, nonce = 0 where id = ${first!.id}::uuid`
          await sql`update dispenses set status = 'broadcast' where id = ${first!.id}::uuid`
        }
        await assert.rejects(insert({ fingerprint: `while-${status}` }), /live_recipient_uniq/)
      }
      await sql`update dispenses set status = 'failed', failure_reason = 'done', settled_at = now() where id = ${first!.id}::uuid`
      const [second] = await insert({ fingerprint: 'after-terminal' })
      assert.ok(second?.id)
    })

    it('the in-flight index covers exactly the states that hold a nonce', async () => {
      assert.deepEqual([...IN_FLIGHT_STATES], ['signing', 'signed', 'broadcast'])
      // `queued` is deliberately NOT in it: a queue of a hundred requests is normal and none of
      // them has read a nonce.
      await insert({ fingerprint: 'q1' })
      const [other] = await insert({ recipient: testAddress(0xb0).toLowerCase(), fingerprint: 'q2' })
      assert.ok(other?.id, 'two queued dispenses must coexist')

      await sql`update dispenses set status = 'signing' where fingerprint = 'q1'`
      await assert.rejects(
        sql`update dispenses set status = 'signing' where fingerprint = 'q2'`,
        /in_flight_uniq/,
      )
    })
  })
})

/* ================================================================ jobs */

describe('leased jobs', { skip }, () => {
  let sql: postgres.Sql

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

  /**
   * Rule 8: there is no `setInterval` in this repository doing domain work. The lease key names the
   * CHAIN, because the contended resource is the nonce.
   */
  it('the dispense job is keyed on the chain, not on a dispense', () => {
    const dispense = RECURRING.find((r) => r.kind === DISPENSE_KIND)
    assert.equal(dispense?.key, CHAIN_KEY)
    assert.equal(dispense?.key, 'ember:testnet')
  })

  it('N replicas seeding at boot produce one row per recurring job', async () => {
    const queues = ['a', 'b', 'c'].map((owner) => new JobQueue(sql as unknown as JobsSql, { owner }))
    await Promise.all(queues.map(seedRecurring))
    const rows = (await sql`select kind, key from jobs order by kind`) as ReadonlyArray<{ kind: string; key: string }>
    assert.equal(rows.length, RECURRING.length)
    assert.deepEqual(rows.map((r) => `${r.kind}/${r.key}`).sort(), [
      `${DISPENSE_KIND}/${CHAIN_KEY}`,
      `${RETENTION_KIND}/global`,
    ])
  })

  it('a handler is registered for every recurring kind, so none can dead-letter unclaimed', () => {
    const runner = new JobRunner({ queue: new JobQueue(sql as unknown as JobsSql, { owner: 'x' }) })
    registerHandlers(runner, {
      dispense: harness(sql, { node: fundedNode(), custody: fakeCustody(), limits: testLimits() }),
      logger: quietLogger(),
      metrics: testMetrics(),
      retentionDays: 30,
    })
    // `register` throws on a duplicate kind, so registering each again proves each was registered
    // exactly once and that the set matches RECURRING.
    for (const job of RECURRING) {
      assert.throws(() => runner.register(job.kind, async () => {}), /already registered/, `${job.kind} has no handler`)
    }
  })

  describe('retention', () => {
    const settled = (status: 'confirmed' | 'failed', ageDays: number, i: number) => sql`
      insert into dispenses (recipient, requester, status, amount_wei, chain_id, fingerprint,
                             nonce, raw_tx, tx_hash, block_number, failure_reason, settled_at)
      values (${testAddress(0x1000 + i).toLowerCase()}, 'ip:t', ${status}, 1, ${TESTNET_CHAIN_ID},
              ${`fp-${status}-${i}`}, 0, '0xab', ${`0x${i.toString(16).padStart(64, 'a')}`},
              ${status === 'confirmed' ? 1 : null},
              ${status === 'failed' ? 'because' : null},
              now() - make_interval(days => ${ageDays}))
    `

    it('prunes settled rows past the horizon and keeps the rest', async () => {
      await settled('confirmed', 90, 1)
      await settled('failed', 90, 2)
      await settled('confirmed', 1, 3)
      const pruned = await pruneSettled(sql as unknown as Db, 30)
      assert.equal(pruned, 2)
      const rows = (await sql`select count(*)::int as n from dispenses`) as ReadonlyArray<{ n: number }>
      assert.equal(rows[0]?.n, 1)
    })

    /**
     * A dispense stuck in `broadcast` is a signed transaction whose fate nobody knows, which makes
     * it the single most important row in the database. Deleting it would destroy the only record
     * that it exists.
     */
    it('never prunes a live row, however old', async () => {
      await sql`
        insert into dispenses (recipient, requester, status, amount_wei, chain_id, fingerprint,
                               nonce, raw_tx, tx_hash, created_at)
        values (${testAddress(0x2000).toLowerCase()}, 'ip:t', 'broadcast', 1, ${TESTNET_CHAIN_ID}, 'stuck',
                0, '0xab', ${`0x${'f'.repeat(64)}`}, now() - interval '400 days')
      `
      assert.equal(await pruneSettled(sql as unknown as Db, 1), 0)
    })

    /** A grant row IS the cooldown. Deleting one hands its address a fresh drip. */
    it('never prunes a grant row', async () => {
      await sql`insert into faucet_address_grants (recipient, last_granted_at) values (${testAddress(0x3000).toLowerCase()}, now() - interval '400 days')`
      await pruneSettled(sql as unknown as Db, 1)
      const rows = (await sql`select count(*)::int as n from faucet_address_grants`) as ReadonlyArray<{ n: number }>
      assert.equal(rows[0]?.n, 1)
    })
  })
})

/* ================================================================ no timers */

/**
 * Rule 8, checked in the source rather than only in the design. CI greps for this too; having it
 * here means a `setInterval` fails the suite before it fails the build.
 */
describe('there is no unleased timer in this service', () => {
  it('no source file arms a setInterval', async () => {
    const { readdir, readFile } = await import('node:fs/promises')
    const dir = new URL('.', import.meta.url).pathname
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    assert.ok(files.length > 5, 'precondition: the source files must actually be found')
    for (const file of files) {
      const source = await readFile(`${dir}${file}`, 'utf8')
      // The word appears in prose in several headers — it is what this service replaced — so the
      // check is for a CALL.
      assert.doesNotMatch(source, /setInterval\s*\(/, `${file} arms a setInterval`)
    }
  })
})
