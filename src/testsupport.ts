/**
 * The database harness, and the fakes.
 *
 * **A database test runs only against a database whose name says it is a test database.**
 *
 * Not a convenience: `resetFaucet` truncates every table this service owns, and requiring "test" in
 * the name is the difference between a red build and an emptied environment. The mechanism is
 * `beacon/src/testsupport.ts` exactly — the same variable shape, the same `/test/i` guard on
 * the URL, the same `enabled`/`skip` pair — because CI keys off it: the reusable workflow exports
 * `FAUCET_TEST_DATABASE_URL` and **fails the build if the database suite skipped**, so a harness
 * that spelled the variable differently would produce a green build that proved nothing.
 *
 * ## Why the proofs do not need a Hearth node
 *
 * `indexer/src/hearth.test.ts` skips when no node is reachable, which is honest and which also
 * means that on a machine without one those cases prove nothing. Every proof in this repository —
 * the two-worker race, the concurrent-request race, exactly-once on a lost broadcast, the testnet
 * refusal — runs against `fakeNode` and `fakeCustody` below and a REAL Postgres. The database is
 * real because the constraints and the `FOR UPDATE SKIP LOCKED` lease are the things being proved
 * and a fake database cannot prove them. The chain is fake because what is being proved is what
 * this service does with a node's answers, and a fake is the only way to produce the answer that
 * matters most: a broadcast whose response is lost.
 */

import postgres from 'postgres'
import { migrate, type Sql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import type { Db } from './db.ts'
import { MIGRATIONS, TABLES } from './migrations.ts'
import { registerServiceMetrics } from './server.ts'
import { toChecksumAddress } from './address.ts'
import { AlreadyKnownError, RpcError, RpcUnavailableError, type Rpc, type TransactionReceipt } from './rpc.ts'
import type { CustodyClient, SignedResult, UnsignedDrip } from './custodyclient.ts'
import { CustodySignRefusedError, CustodyUnavailableError } from './custodyclient.ts'
import type { LimitConfig } from './limits.ts'
import { requesterKey, type RequesterConfig } from './requester.ts'
import type { DispenseDeps } from './dispense.ts'

/** Spelled exactly as the reusable CI workflow exports it. See the file header. */
export const TEST_DSN_VAR = 'FAUCET_TEST_DATABASE_URL'

const url = process.env[TEST_DSN_VAR]

export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : `set ${TEST_DSN_VAR} (name must contain "test")`

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the constraints drift out of the tests that are supposed to prove they fire — and two
 * of them, `dispenses_in_flight_uniq` and `dispenses_live_recipient_uniq`, are the two most
 * important lines in this repository.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as Sql, MIGRATIONS, { service: 'faucet-test' })
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetFaucet(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`)
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'faucet-test', sink: () => {} })
}

export function testMetrics(): Metrics {
  return registerServiceMetrics(new Metrics())
}

export const db = (sql: postgres.Sql): Db => sql as unknown as Db

/* ------------------------------------------------------------------ fixtures */

/** The EMBER testnet chain id, restated here ONLY so a test can assert the source agrees. */
export const TESTNET_CHAIN_ID = 7412

export const ONE_EMBER = 10n ** 18n

/** A deterministic, checksummed address from a small number. */
export function testAddress(seed: number): string {
  return toChecksumAddress(`0x${seed.toString(16).padStart(40, '0')}`)
}

export const FUNDING_ADDRESS = testAddress(0xfa) // the faucet's own

/** Limits a test can vary one field of. Deliberately small so a case can exhaust the budget. */
export function testLimits(overrides: Partial<LimitConfig> = {}): LimitConfig {
  return {
    dripWei: 10n * ONE_EMBER,
    addressCooldownSeconds: 3_600,
    requesterLimit: 3,
    requesterWindowSeconds: 3_600,
    budgetWei: 50n * ONE_EMBER,
    budgetWindowSeconds: 3_600,
    ...overrides,
  }
}

/**
 * The pseudonymisation config a test runs under, and the helper that produces a legal requester.
 *
 * `testRequesterKey` exists because `faucet_requester_grants_pseudonymous` and
 * `dispenses_requester_pseudonymous` mean a test can no longer make up a requester — `'ip:test'`
 * is now refused by the database, which is the entire point of the constraint. Every case that
 * needs "some requester" derives one the way the server does, so a test that starts passing a raw
 * value fails on the constraint the production path is held to rather than on a fixture.
 */
export function testRequester(overrides: Partial<RequesterConfig> = {}): RequesterConfig {
  return {
    // Long enough to pass `requiredSecret`'s bar, and obviously not a real one.
    salt: 'a-test-only-requester-salt-0000000000',
    retentionSeconds: 172_800,
    ...overrides,
  }
}

/**
 * A legal requester key for a test. `network` indexes a DISTINCT network, not a distinct host.
 *
 * **It takes a number rather than an address on purpose, and the reason is a bug this caught.**
 * The first version of these fixtures used `198.51.100.1` and `198.51.100.2` for "two different
 * requesters" — which is now ONE requester, because both are in one /24 and the truncation is the
 * point. A test that spells its requesters as addresses invites that mistake every time somebody
 * adds a case. A number cannot: `1` and `2` are two /48s of 2001:db8::/32, the range RFC 3849
 * reserves for documentation, and they are always different buckets.
 *
 * The instant is FIXED rather than `new Date()`. The salt rotates on a clock, so a key derived at
 * the top of a file and a key derived inside a case would be different values on the one run in a
 * thousand that straddles a boundary — a test that fails once a fortnight for a reason nobody can
 * reproduce. Cases that are about rotation pass their own `at`.
 */
export const TEST_INSTANT = new Date('2026-08-05T12:00:00.000Z')

export function testRequesterKey(network = 7, at: Date = TEST_INSTANT): string {
  return requesterKey(`2001:db8:${network.toString(16)}::1`, testRequester(), at)
}

/* ------------------------------------------------------------------ a fake node */

export interface FakeNode {
  readonly rpc: Rpc
  /** Every raw transaction the node was ASKED to accept, including ones it then refused. */
  readonly broadcasts: readonly string[]
  /** Raw transactions the node actually holds. The set that decides `already known`. */
  readonly mempool: ReadonlySet<string>
  setBalance(address: string, wei: bigint): void
  setNonce(address: string, nonce: number): void
  setHeight(height: bigint): void
  /**
   * **Accept the transaction and then lose the response.**
   *
   * The single most important fake in this repository: the node HAS the bytes and the caller never
   * learns it. Every subsequent broadcast of those bytes answers `already known`, which is exactly
   * what a real node does and exactly the condition rule 3 of the brief is about.
   */
  loseNextResponse(): void
  /** Refuse everything with a peer-decided error, as a node with a full mempool would. */
  refuseWith(message: string | null): void
  /** Make every call fail as though the node were unreachable. */
  setUnreachable(value: boolean): void
  mine(rawTx: string, block: bigint, status?: boolean): void
}

export function fakeNode(chainId = TESTNET_CHAIN_ID): FakeNode {
  const balances = new Map<string, bigint>()
  const nonces = new Map<string, number>()
  const broadcasts: string[] = []
  const mempool = new Set<string>()
  const receipts = new Map<string, TransactionReceipt>()
  let height = 1_000n
  let loseNext = false
  let refusal: string | null = null
  let unreachable = false

  const key = (address: string) => address.toLowerCase()

  const hashOf = (rawTx: string): string => {
    // The fake indexes receipts by the RAW BYTES rather than by a hash it computes, so a test does
    // not have to reimplement keccak to say "this transaction was mined". `mine` takes the bytes.
    return rawTx
  }

  const rpc = {
    async call() {
      throw new Error('the fake node is driven through its typed methods, not through call()')
    },
    async chainId(): Promise<number> {
      if (unreachable) throw new RpcUnavailableError('the fake node is unreachable')
      return chainId
    },
    async blockNumber(): Promise<bigint> {
      if (unreachable) throw new RpcUnavailableError('the fake node is unreachable')
      return height
    },
    async getBalance(address: string): Promise<bigint> {
      if (unreachable) throw new RpcUnavailableError('the fake node is unreachable')
      return balances.get(key(address)) ?? 0n
    },
    async getNonce(address: string): Promise<number> {
      if (unreachable) throw new RpcUnavailableError('the fake node is unreachable')
      return nonces.get(key(address)) ?? 0
    },
    async sendRawTransaction(rawTx: string): Promise<string> {
      if (unreachable) throw new RpcUnavailableError('the fake node is unreachable')
      broadcasts.push(rawTx)
      if (mempool.has(rawTx)) {
        // A real node's answer to a re-broadcast of bytes it already holds.
        throw new AlreadyKnownError('already known')
      }
      if (refusal !== null) throw new RpcError(-32_000, refusal)
      mempool.add(rawTx)
      if (loseNext) {
        loseNext = false
        // ACCEPTED, and the response never arrives. The bytes are in the mempool.
        throw new RpcUnavailableError('the connection dropped after the node took the transaction')
      }
      return `0x${'11'.repeat(32)}`
    },
    async getTransactionReceipt(): Promise<TransactionReceipt | null> {
      if (unreachable) throw new RpcUnavailableError('the fake node is unreachable')
      // Keyed on the single in-flight transaction, which is all this service ever has.
      const only = [...receipts.values()][0]
      return only ?? null
    },
  } as unknown as Rpc

  return {
    rpc,
    broadcasts,
    mempool,
    setBalance: (address, value) => void balances.set(key(address), value),
    setNonce: (address, value) => void nonces.set(key(address), value),
    setHeight: (value) => void (height = value),
    loseNextResponse: () => void (loseNext = true),
    refuseWith: (message) => void (refusal = message),
    setUnreachable: (value) => void (unreachable = value),
    mine: (rawTx, block, status = true) => void receipts.set(hashOf(rawTx), { blockNumber: block, status }),
  }
}

/* ------------------------------------------------------------------ a fake custody */

export interface FakeCustody extends CustodyClient {
  /**
   * Every signature this custody produced.
   *
   * **The assertion in the concurrency tests is on the LENGTH of this, not on row states.** A row
   * state is what this service believes; a signature is what actually happened to a nonce.
   */
  readonly signatures: readonly UnsignedDrip[]
  refuse(code: string | null): void
  setUnavailable(value: boolean): void
}

export function fakeCustody(): FakeCustody {
  const signatures: UnsignedDrip[] = []
  let refusal: string | null = null
  let unavailable = false

  return {
    signatures,
    refuse: (code) => void (refusal = code),
    setUnavailable: (value) => void (unavailable = value),
    async sign(input: { payload: UnsignedDrip; correlationId: string }): Promise<SignedResult> {
      if (unavailable) throw new CustodyUnavailableError('the fake custody is unavailable')
      if (refusal !== null) throw new CustodySignRefusedError(403, refusal, `refused: ${refusal}`)
      signatures.push(input.payload)
      // Deterministic bytes derived from the nonce and the destination, so two signatures over
      // different transactions differ and two over the same transaction are identical — which is
      // what makes the fake node's `already known` mean what it means.
      const body = Buffer.from(
        `${input.payload.nonce}:${input.payload.to}:${input.payload.value}`,
        'utf8',
      ).toString('hex')
      return { signedTx: `0x${body}`, auditId: `audit-${signatures.length}` }
    },
  }
}

/* ------------------------------------------------------------------ the wiring */

export interface HarnessOptions {
  readonly node?: FakeNode
  readonly custody?: FakeCustody
  readonly limits?: LimitConfig
  readonly maxRecipientBalanceWei?: bigint
  readonly reserveWei?: bigint
}

/** A `DispenseDeps` over a real pool and the two fakes. */
export function harness(sql: postgres.Sql, options: HarnessOptions = {}): DispenseDeps {
  const node = options.node ?? fakeNode()
  const custody = options.custody ?? fakeCustody()
  const limits = options.limits ?? testLimits()
  return {
    sql: db(sql),
    rpc: node.rpc,
    custody,
    logger: quietLogger(),
    metrics: testMetrics(),
    fundingAddress: FUNDING_ADDRESS,
    chainId: TESTNET_CHAIN_ID,
    // Two, not sixty. The pinned depth is `contracts-chain`'s and `index.ts` uses it; a test that
    // had to mine sixty blocks to prove one confirmation would be a test about arithmetic.
    confirmations: 2,
    gasPriceWei: 1_000_000_000n,
    limits,
    maxRecipientBalanceWei: options.maxRecipientBalanceWei ?? 100n * ONE_EMBER,
    reserveWei: options.reserveWei ?? ONE_EMBER,
  }
}

/** A funded faucet, ready to dispense. The two lines every dispense test would otherwise repeat. */
export function fundedNode(chainId = TESTNET_CHAIN_ID): FakeNode {
  const node = fakeNode(chainId)
  node.setBalance(FUNDING_ADDRESS, 10_000n * ONE_EMBER)
  return node
}

/** Read one dispense row, for the assertions that are about what the database holds. */
export async function readRow(
  sql: postgres.Sql,
  id: string,
): Promise<{
  status: string
  nonce: number | null
  raw_tx: string | null
  tx_hash: string | null
  confirmations: number
  failure_reason: string | null
} | null> {
  const rows = (await sql`
    select status, nonce, raw_tx, tx_hash, confirmations, failure_reason
      from dispenses where id = ${id}::uuid
  `) as ReadonlyArray<{
    status: string
    nonce: string | number | null
    raw_tx: string | null
    tx_hash: string | null
    confirmations: number
    failure_reason: string | null
  }>
  const row = rows[0]
  if (!row) return null
  return { ...row, nonce: row.nonce === null ? null : Number(row.nonce) }
}
