/**
 * The HTTP surface, over a real socket and a real database.
 *
 * Requests go over the wire rather than into a handler function, because two of the things most
 * likely to be wrong are not visible from inside one: the status code and the headers that carry a
 * refusal, and whether a secret reaches a response body.
 *
 * **The last suite in this file is the important one.** It asks every route for something it should
 * not give up, and asserts on the bytes that came back.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { TokenError, type Principal } from '@cloudsforge/auth'
import type postgres from 'postgres'
import { createServer, scrapeRefresh } from './server.ts'
import { driveChain } from './dispense.ts'
import { REQUESTER_KEY_PATTERN, requesterKey } from './requester.ts'
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
  type FakeCustody,
  type FakeNode,
} from './testsupport.ts'

const OPERATOR_TOKEN = 'an-operator-token-of-sufficient-length'
const ORIGIN = 'https://faucet.cloudsforge.online'

describe('the http surface', { skip }, () => {
  let sql: postgres.Sql
  let server: Server
  let base: string
  let node: FakeNode
  let custody: FakeCustody
  const limits = testLimits()
  const ALICE = testAddress(0xa1)

  /** Nothing here has a real identity service; the static token is the credential under test. */
  const verifier = {
    async principal(): Promise<Principal> {
      throw new TokenError('no identity service in this suite', 'invalid')
    },
  }

  before(async () => {
    if (!enabled) return
    sql = openDb(8)
    await migrateTestDb(sql)

    const lifecycle = new Lifecycle({})
    lifecycle.addProbe({
      name: 'postgres',
      kind: 'hard',
      check: async () => (await sql`select 1`) ? { state: 'pass' } : { state: 'fail' },
    })
    lifecycle.markReady()

    const metrics = testMetrics()
    server = createServer({
      lifecycle,
      logger: quietLogger(),
      metrics,
      verifier,
      sql: db(sql),
      token: OPERATOR_TOKEN,
      chainId: TESTNET_CHAIN_ID,
      fundingAddress: FUNDING_ADDRESS,
      limits,
      requester: testRequester(),
      corsOrigins: [ORIGIN],
      beforeScrape: scrapeRefresh({ sql: db(sql), metrics, limits }),
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    if (!enabled) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await sql.end({ timeout: 5 })
  })

  beforeEach(async () => {
    if (!enabled) return
    await resetFaucet(sql)
    node = fundedNode()
    custody = fakeCustody()
  })

  const drip = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/v1/drips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  /* ---------------------------------------------------------------- health */

  describe('health', () => {
    it('/livez is static and consults nothing', async () => {
      const response = await fetch(`${base}/livez`)
      assert.equal(response.status, 200)
    })

    it('/readyz reports the real probes', async () => {
      const response = await fetch(`${base}/readyz`)
      assert.equal(response.status, 200)
      const body = (await response.json()) as { ready: boolean; checks: Array<{ name: string; kind: string }> }
      assert.equal(body.ready, true)
      const postgres = body.checks.find((c) => c.name === 'postgres')
      // HARD: without Postgres this service cannot refuse a request safely, and a faucet that
      // cannot refuse is worse than a faucet that is down.
      assert.equal(postgres?.kind, 'hard')
    })

    it('/metrics costs a credential', async () => {
      assert.equal((await fetch(`${base}/metrics`)).status, 401)
      assert.equal((await fetch(`${base}/metrics`, { headers: { 'x-faucet-token': 'wrong' } })).status, 401)
      const ok = await fetch(`${base}/metrics`, { headers: { 'x-faucet-token': OPERATOR_TOKEN } })
      assert.equal(ok.status, 200)
      assert.match(await ok.text(), /faucet_budget_remaining_wei/)
    })
  })

  /* ---------------------------------------------------------------- the faucet */

  describe('GET /v1/faucet', () => {
    it('publishes the terms without a credential, in decimal strings', async () => {
      const response = await fetch(`${base}/v1/faucet`)
      assert.equal(response.status, 200)
      const body = (await response.json()) as Record<string, unknown>
      assert.equal(body['chainId'], TESTNET_CHAIN_ID)
      assert.equal(body['network'], 'testnet')
      assert.equal(body['fundingAddress'], FUNDING_ADDRESS)
      // Never a JSON number: 1e19 wei is past what a double carries exactly, and a client using
      // JSON.parse would silently receive a rounded amount.
      assert.equal(typeof body['dripWei'], 'string')
      assert.equal(body['dripWei'], (10n * ONE_EMBER).toString(10))
      assert.equal(typeof body['budgetRemainingWei'], 'string')
    })
  })

  /* ---------------------------------------------------------------- drips */

  describe('POST /v1/drips', () => {
    it('accepts with 202 and a poll link, because nothing has been signed yet', async () => {
      const response = await drip({ address: ALICE })
      assert.equal(response.status, 202)
      const body = (await response.json()) as Record<string, unknown>
      assert.equal(body['status'], 'queued')
      assert.equal(body['recipient'], ALICE.toLowerCase())
      assert.equal(body['amountWei'], (10n * ONE_EMBER).toString(10))
      assert.equal(body['poll'], `/v1/drips/${String(body['id'])}`)
    })

    it('answers a retry with 200 and the original dispense', async () => {
      const first = (await (await drip({ address: ALICE, idempotencyKey: 'k1' })).json()) as { id: string }
      const again = await drip({ address: ALICE, idempotencyKey: 'k1' })
      assert.equal(again.status, 200)
      const body = (await again.json()) as { id: string; duplicate: boolean }
      assert.equal(body.id, first.id)
      assert.equal(body.duplicate, true)
    })

    /**
     * **THE AMOUNT IS A SERVER-SIDE CONSTANT.** Every field a caller might hope influences it is
     * sent at once, and the payout is unchanged. `server.js` in the frozen service: "every
     * faucet that has ever been drained let the caller influence the amount".
     */
    it('ignores every attempt to name an amount', async () => {
      const response = await drip({
        address: ALICE,
        amount: '1000000',
        amountWei: (10n ** 30n).toString(10),
        value: 999,
        drip: '500',
        dripWei: '500000000000000000000',
        limits: { dripWei: '1' },
      })
      assert.equal(response.status, 202)
      const body = (await response.json()) as { amountWei: string; id: string }
      assert.equal(body.amountWei, (10n * ONE_EMBER).toString(10))
      const rows = (await sql`select amount_wei from dispenses where id = ${body.id}::uuid`) as ReadonlyArray<{ amount_wei: string }>
      assert.equal(rows[0]?.amount_wei, (10n * ONE_EMBER).toString(10))
    })

    it('refuses a second address inside the cooldown with 429 and a retry-after header', async () => {
      await drip({ address: ALICE })
      const second = await drip({ address: ALICE, idempotencyKey: 'a-different-request' })
      assert.equal(second.status, 429)
      const retryAfter = Number(second.headers.get('retry-after'))
      assert.ok(Number.isInteger(retryAfter) && retryAfter > 0, `retry-after was ${second.headers.get('retry-after')}`)
      const body = (await second.json()) as { error: { code: string } }
      assert.equal(body.error.code, 'address_cooldown')
    })

    it('refuses a bad address with 400 and names the fault', async () => {
      for (const [address, pattern] of [
        ['0xnothex', /40 hex/],
        ['ember1qqq', /pre-EVM/],
        ['0x0000000000000000000000000000000000000000', /zero address/],
        [42, /string/],
      ] as const) {
        const response = await drip({ address })
        assert.equal(response.status, 400, `${String(address)} was not refused`)
        const body = (await response.json()) as { error: { code: string; message: string } }
        assert.equal(body.error.code, 'invalid_address')
        assert.match(body.error.message, pattern)
      }
    })

    it("refuses the faucet's own funding address", async () => {
      const response = await drip({ address: FUNDING_ADDRESS })
      assert.equal(response.status, 400)
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'own_address')
    })

    it('refuses a body that is not a JSON object, and an oversized one', async () => {
      assert.equal((await drip('not json')).status, 400)
      assert.equal((await drip('[]')).status, 400)
      assert.equal((await drip('')).status, 400)
      // Refused, not truncated: a truncated body can parse as a prefix nobody sent.
      assert.equal((await drip({ address: ALICE, pad: 'x'.repeat(8_000) })).status, 400)
    })

    /* ── WHAT REACHES THE DATABASE WHEN A REAL ADDRESS ARRIVES. micro-org#163. ────────────────
     *
     * These four run over a real socket with a real forwarded header, so they observe the value
     * the estate would actually store rather than what `requesterKey` returns in isolation —
     * which is what `requester.test.ts` already proves. Two things are being asserted here that
     * only the full path can show: that the header reaches the derivation at all, and that the
     * address does not reach the row.
     *
     * The addresses are documentation-range (RFC 5737 / RFC 3849) and no case prints one.
     */
    it('stores no part of the client address, in either column that holds a requester', async () => {
      await drip({ address: ALICE }, { 'x-forwarded-for': '198.51.100.9, 10.0.0.1, 10.0.0.2' })

      const dispenses = (await sql`select requester from dispenses`) as ReadonlyArray<{ requester: string }>
      const grants = (await sql`select requester from faucet_requester_grants`) as ReadonlyArray<{
        requester: string
      }>
      assert.equal(dispenses.length, 1)
      assert.equal(grants.length, 1)

      /*
       * ── WHY THIS DOES NOT SEARCH THE STORED VALUE FOR OCTETS ─────────────────────────────────
       *
       * It used to. The loop was `for (const octet of ['198', '51', '100']) assert.ok(!stored
       * .includes(octet))`, on the reasoning that a shape assertion alone would pass on a key with
       * the address appended. That reasoning was wrong twice over.
       *
       * It was unnecessary, because REQUESTER_KEY_PATTERN is ANCHORED at both ends and admits
       * exactly 32 hex characters. Nothing can be appended to a value that matches it, and no
       * dotted quad can be inside one, because `.` is not a hex digit. The shape assertion is the
       * whole proof.
       *
       * And it was actively harmful, because those three octets are spelled entirely in characters
       * that a hex digest is made of, so the loop was really asking a 128-bit random string not to
       * contain `51`. It does, about 15% of the time. That is not a flake that shows up on one run
       * in a thousand: the key rotates on a 2-day epoch (`retentionSeconds: 172_800`), so the
       * digest for this /24 is FIXED for two days at a time, and the loop makes CI deterministically
       * red for a whole window whenever it lands on one. It did, at 2026-08-17T00:00Z, epoch 10341:
       *
       *   r1:2df36bf7f2a68c10809308f045b8d351
       *                                   ^^
       *
       * So the intent is asserted directly instead. The stored value must EQUAL the key derived
       * here from the truncated subject — which proves it is a function of the /24 and the salt and
       * of nothing else, the property the octet search was reaching for and could not reach.
       */
      /*
       * TWO EPOCHS ARE ACCEPTED, and that is not a hedge. The server derived its key from the real
       * clock, because it is a real server over a real socket — this case cannot hand it a fixed
       * instant the way `testsupport`'s fixtures do. So a run that straddles a 2-day boundary
       * between the request and this line would compare against the wrong epoch. Both values are
       * equally legitimate derivations of the same /24, so both are allowed; what is being proven
       * is that the stored value IS one of them, and neither of them is derived from anything but
       * the truncated subject and the salt.
       */
      const now = Date.now()
      const config = testRequester()
      const legitimate = [now, now - config.retentionSeconds * 1000].map((at) =>
        requesterKey('198.51.100.9', config, new Date(at)),
      )
      for (const key of legitimate) assert.match(key, REQUESTER_KEY_PATTERN)

      for (const stored of [dispenses[0]?.requester, grants[0]?.requester]) {
        assert.match(stored ?? '', REQUESTER_KEY_PATTERN)
        assert.ok(
          legitimate.includes(stored ?? ''),
          'the stored key is not the derivation of this /24 under either live epoch',
        )
        // Belt and braces on the one substring that CANNOT arise by coincidence: a dotted quad
        // contains `.`, which the anchored pattern above already forbids.
        assert.ok(!stored?.includes('198.51.100.9'))
      }
    })

    it('keys the two columns on the same value, so the ledger and the counter agree', async () => {
      await drip({ address: ALICE }, { 'x-forwarded-for': '198.51.100.9' })
      const [row] = (await sql`
        select d.requester as ledger, g.requester as counter
          from dispenses d join faucet_requester_grants g on g.requester = d.requester
      `) as ReadonlyArray<{ ledger: string; counter: string }>
      assert.equal(row?.ledger, row?.counter)
    })

    it('reads the first hop of x-forwarded-for and nothing further', async () => {
      // Still the first hop only — everything past it is attacker-appendable. Observed through
      // the derivation: a request naming the first hop alone must land in the same bucket as one
      // that names it with proxies behind it.
      await drip({ address: ALICE }, { 'x-forwarded-for': '198.51.100.9, 10.0.0.1, 10.0.0.2' })
      const withHops = (await sql`select requester from dispenses`) as ReadonlyArray<{ requester: string }>
      await sql`truncate dispenses, faucet_requester_grants, faucet_address_grants cascade`

      await drip({ address: ALICE }, { 'x-forwarded-for': '198.51.100.9' })
      const alone = (await sql`select requester from dispenses`) as ReadonlyArray<{ requester: string }>
      assert.equal(withHops[0]?.requester, alone[0]?.requester)

      // …and a DIFFERENT first hop is a different bucket, or the assertion above would hold for a
      // derivation that ignored the header entirely.
      await sql`truncate dispenses, faucet_requester_grants, faucet_address_grants cascade`
      await drip({ address: ALICE }, { 'x-forwarded-for': '192.0.2.9, 10.0.0.1' })
      const other = (await sql`select requester from dispenses`) as ReadonlyArray<{ requester: string }>
      assert.notEqual(alone[0]?.requester, other[0]?.requester)
    })

    it('bounds the requester however long the header was', async () => {
      await drip({ address: ALICE }, { 'x-forwarded-for': 'a'.repeat(500) })
      const rows = (await sql`select requester from dispenses`) as ReadonlyArray<{ requester: string }>
      // 35 characters, always: the length is a property of the derivation now and not of the
      // caller's header, so an unbounded header cannot become an unbounded row.
      assert.equal(rows[0]?.requester.length, 35)
    })

    it('refuses a raw address written past the handler, which is what makes this permanent', async () => {
      // The constraint, not the convention. `server.ts` could be reverted tomorrow; this is what
      // would stop the revert from committing a row.
      await assert.rejects(
        sql`
          insert into faucet_requester_grants (requester, window_started_at, grants, last_granted_at)
          values ('ip:198.51.100.9', now(), 1, now())
        `,
        /faucet_requester_grants_pseudonymous/,
      )
      await assert.rejects(
        sql`
          insert into dispenses (recipient, requester, status, amount_wei, chain_id, fingerprint)
          values (${ALICE.toLowerCase()}, 'ip:198.51.100.9', 'queued', 1, ${TESTNET_CHAIN_ID}, 'raw-ip')
        `,
        /dispenses_requester_pseudonymous/,
      )
    })
  })

  /* ---------------------------------------------------------------- polling */

  describe('GET /v1/drips/:id', () => {
    it('follows a drip from queued to confirmed', async () => {
      const { id } = (await (await drip({ address: ALICE })).json()) as { id: string }
      assert.equal(((await (await fetch(`${base}/v1/drips/${id}`)).json()) as { status: string }).status, 'queued')

      const deps = harness(sql, { node, custody, limits })
      await driveChain(deps)
      const broadcast = (await (await fetch(`${base}/v1/drips/${id}`)).json()) as { status: string; txHash: string }
      assert.equal(broadcast.status, 'broadcast')
      assert.match(broadcast.txHash, /^0x[0-9a-f]{64}$/)

      node.mine(node.broadcasts[0]!, 1_000n)
      node.setHeight(1_010n)
      await driveChain(deps)
      const confirmed = (await (await fetch(`${base}/v1/drips/${id}`)).json()) as {
        status: string
        blockNumber: string
      }
      assert.equal(confirmed.status, 'confirmed')
      assert.equal(typeof confirmed.blockNumber, 'string')
    })

    it('is a 404 for an unknown id and for a malformed one', async () => {
      assert.equal((await fetch(`${base}/v1/drips/00000000-0000-4000-8000-000000000000`)).status, 404)
      // Bounded before it reaches the database: a 22P02 would surface as a 500 and put a
      // caller-controlled string into an error log.
      assert.equal((await fetch(`${base}/v1/drips/not-a-uuid`)).status, 404)
      assert.equal((await fetch(`${base}/v1/drips/${"'; drop table dispenses; --"}`)).status, 404)
    })

    it('the table is still there', async () => {
      const rows = (await sql`select count(*)::int as n from dispenses`) as ReadonlyArray<{ n: number }>
      assert.equal(typeof rows[0]?.n, 'number')
    })
  })

  /* ---------------------------------------------------------------- cors */

  describe('CORS is an allowlist', () => {
    it('answers a listed origin', async () => {
      const response = await fetch(`${base}/v1/faucet`, { headers: { origin: ORIGIN } })
      assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN)
    })

    it('gives an unlisted origin no headers at all, and never a wildcard', async () => {
      const response = await fetch(`${base}/v1/faucet`, { headers: { origin: 'https://evil.example' } })
      assert.equal(response.headers.get('access-control-allow-origin'), null)
    })

    it('refuses a preflight from an unlisted origin', async () => {
      const response = await fetch(`${base}/v1/drips`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
      assert.equal(response.status, 403)
    })
  })

  /* ================================================================ secrets */

  /**
   * **RULE 6. The funding key is never logged, never returned by any route, never in an error
   * message.**
   *
   * This service is in the strongest position to comply, because it has no key: custody holds it
   * and `env.ts` has no variable that accepts one (`env.test.ts` proves that separately). What is
   * left to prove is that the things that ARE worth stealing — the operator token, the raw signed
   * bytes, the nonce, custody's audit id — do not leak from a route either.
   *
   * `micro-custody` deleted its admin-reveal endpoint rather than guard it. There is no equivalent
   * here, and this suite is what keeps it that way.
   */
  describe('nothing sensitive leaves by any route', () => {
    /** Every route this service serves, asked with and without a credential. */
    async function everyResponseBody(): Promise<string> {
      const { id } = (await (await drip({ address: ALICE })).json()) as { id: string }
      const deps = harness(sql, { node, custody, limits })
      await driveChain(deps)

      const responses = await Promise.all([
        fetch(`${base}/livez`),
        fetch(`${base}/readyz`),
        fetch(`${base}/metrics`, { headers: { 'x-faucet-token': OPERATOR_TOKEN } }),
        fetch(`${base}/metrics`),
        fetch(`${base}/v1/faucet`),
        fetch(`${base}/v1/drips/${id}`),
        fetch(`${base}/v1/drips/not-a-uuid`),
        drip({ address: ALICE }),
        drip({ address: '0xbad' }),
        drip('not json'),
        fetch(`${base}/nope`),
      ])
      const bodies = await Promise.all(responses.map((r) => r.text()))
      return bodies.join('\n')
    }

    it('never serves the operator token back', async () => {
      const all = await everyResponseBody()
      assert.doesNotMatch(all, new RegExp(OPERATOR_TOKEN))
    })

    it('never serves the signed transaction bytes, the nonce, or the custody audit id', async () => {
      const all = await everyResponseBody()
      const row = (await sql`select raw_tx, custody_audit_id from dispenses limit 1`) as ReadonlyArray<{
        raw_tx: string | null
        custody_audit_id: string | null
      }>
      const rawTx = row[0]?.raw_tx
      assert.ok(rawTx, 'precondition: a signature must exist for this to prove anything')
      assert.ok(!all.includes(rawTx), 'the raw signed transaction reached a response body')
      assert.ok(!all.includes(String(row[0]?.custody_audit_id)), "custody's audit id reached a response body")
      assert.doesNotMatch(all, /"nonce"/)
      assert.doesNotMatch(all, /raw_tx|rawTx/)
    })

    /**
     * A caught error's own text is never served. It may carry a node URL with a key in its path, a
     * driver message quoting a row, or custody's response — so the mapper emits a fixed message per
     * code and the operator gets the detail in the log.
     */
    it('a 500 says nothing about what went wrong', async () => {
      // Break the pool underneath a route that must touch it.
      const broken = createServer({
        lifecycle: (() => {
          const l = new Lifecycle({})
          l.markReady()
          return l
        })(),
        logger: quietLogger(),
        metrics: testMetrics(),
        verifier,
        sql: {
          // A driver failure whose message carries a connection string, which is the realistic
          // shape of the thing that must not be echoed.
          async begin() {
            throw new Error('connection to postgres://faucet:hunter2@db:5432/faucet failed')
          },
          async unsafe() {
            throw new Error('connection to postgres://faucet:hunter2@db:5432/faucet failed')
          },
        } as unknown as Db,
        token: OPERATOR_TOKEN,
        chainId: TESTNET_CHAIN_ID,
        fundingAddress: FUNDING_ADDRESS,
        limits,
        requester: testRequester(),
        corsOrigins: [],
      })
      await new Promise<void>((resolve) => broken.listen(0, '127.0.0.1', () => resolve()))
      const brokenBase = `http://127.0.0.1:${(broken.address() as AddressInfo).port}`
      try {
        const response = await fetch(`${brokenBase}/v1/drips`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ address: ALICE }),
        })
        assert.equal(response.status, 500)
        const text = await response.text()
        assert.doesNotMatch(text, /hunter2/)
        assert.doesNotMatch(text, /postgres:\/\//)
        assert.match(text, /the request could not be completed/)
      } finally {
        await new Promise<void>((resolve) => broken.close(() => resolve()))
      }
    })
  })
})
