/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step carries the reason it must precede the next; the ordering is the substance of this file.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a separate
 * one-shot process — AD-17 and rule 7. Here that matters concretely: below `SCHEMA_VERSION` the two
 * partial unique indexes that stop a double-dispense may not exist.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **STEP 5 IS THE ONE THAT MATTERS: THE NODE IS ASKED WHAT CHAIN IT IS, AND A DISAGREEMENT IS
 * FATAL.**
 *
 * `env.ts` has already established that this build dispenses on chain 7412 and nothing else — the
 * id is read from the exact-pinned `@cloudsforge/contracts-chain` and is not configurable. What it
 * cannot establish is what is at the other end of `FAUCET_RPC_URL`. That is a boot check, it is
 * fatal, and it is fatal in both directions: a node that reports a different chain, and a node that
 * cannot be reached at all.
 *
 * The frozen service is deliberately lenient here — "a node that is down at boot is a normal thing
 * on a testnet ... the faucet recovers on its own" (`stack/repos/hearth/tools/faucet/
 * src/index.js:88-94`) — and for a laptop tool that is a defensible call. It is the wrong call for
 * a service holding a signing credential: an unreachable node at boot means the chain identity was
 * never verified, and the service would begin queueing requests it intends to sign against a chain
 * it has never spoken to. Once the check has passed, a node that goes away later is a SOFT
 * readiness probe and the queue holds — which is the same tolerance, applied where it is safe.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { CHAIN_ID, CONFIRMATIONS, NETWORK, SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics, scrapeRefresh } from './server.ts'
import { registerHandlers, rescheduleRecurring, sampleQueue, seedRecurring } from './jobs.ts'
import { httpCustodyClient } from './custodyclient.ts'
import { Rpc } from './rpc.ts'
import type { DispenseDeps } from './dispense.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret, or a
//    FAUCET_CHAIN_ID that is not the testnet's, has already exited with a structured line.

// 2. Telemetry, before anything that can fail, so a pool failure is a structured line rather than a
//    bare V8 stack the collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  network: NETWORK,
  chainId: CHAIN_ID,
  confirmations: CONFIRMATIONS,
  // The funding ADDRESS, which is public on chain the moment the first drip lands. Never anything
  // else about the key, which this process does not hold — see custodyclient.ts.
  fundingAddress: env.fundingAddress,
  dripWei: env.limits.dripWei.toString(10),
  budgetWei: env.limits.budgetWei.toString(10),
})

// 3. The database pool. Opened before the schema assertion (which is a query) and before the
//    Lifecycle (whose readiness probe closes over it).
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  onnotice: () => {},
})
/**
 * The pool, under both names it is known by.
 *
 * `sql` is `postgres.js`'s own handle and is what the domain modules take (`db.ts` says why: they
 * need `begin`, and `@cloudsforge/db`'s deliberately narrow `Sql` has no transaction). `schemaDb`
 * is the same object under the narrow type that `assertSchemaAtLeast` and `migrate` accept. One
 * pool, two views, and no second connection.
 */
const schemaDb = sql as unknown as Sql

// 4. Assert the schema. This does NOT migrate. Failing here rather than serving is the point.
try {
  await assertSchemaAtLeast(schemaDb, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. THE CHAIN CHECK. See the file header. Fatal, in both directions.
const rpc = new Rpc({ url: env.rpcUrl, deadlineMs: env.rpcDeadlineMs })
try {
  const reported = await rpc.chainId()
  if (reported !== CHAIN_ID) {
    throw new Error(
      `the node reports chain ${reported}; this faucet dispenses on the EMBER ${NETWORK} ` +
        `(${CHAIN_ID}) only. A faucet is an unauthenticated withdrawal endpoint and the only ` +
        'thing making that acceptable is that the coin is worthless.',
    )
  }
  logger.info('node reached and verified', { chainId: reported, height: (await rpc.blockNumber()).toString(10) })
} catch (err) {
  logger.fatal('the chain could not be verified', { err, chainId: CHAIN_ID })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 6. Custody. Constructed but not dialled: a signature is only needed when there is something to
//    sign, and blocking boot on it would make a custody restart a faucet outage.
const custody = httpCustodyClient({
  baseUrl: env.custodyUrl,
  token: () => env.custodyToken,
  deadlineMs: env.custodyDeadlineMs,
  binding: {
    address: env.fundingAddress,
    userId: env.custodyUserId,
    orderId: env.custodyOrderId,
  },
})

// 7. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report. One HARD probe and one SOFT one; `server.ts` says why each is which.
const lifecycle = new Lifecycle({
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})
lifecycle.addProbe(
  postgresProbe('postgres', (signal) =>
    Promise.race([
      sql`select 1`,
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
      }),
    ]),
  ),
)
lifecycle.addProbe({
  name: 'hearth-node',
  // SOFT. A testnet node restarting is ordinary, the queue holds rather than fails, and the drips
  // land when it comes back. Taking this replica out of the balancer would stop it ACCEPTING
  // requests, which is the one thing it can still safely do.
  kind: 'soft',
  async check() {
    const reported = await rpc.chainId()
    return reported === CHAIN_ID
      ? { state: 'pass' }
      : // Not `fail`: this cannot happen without the boot check having passed against a different
        // node, which means somebody has repointed a load balancer under a running faucet. It is
        // reported at `warn` and nothing signs, because `driveChain` reads the nonce from the same
        // endpoint and custody binds the chain id independently from the address's own row.
        { state: 'warn', detail: `the node now reports chain ${reported}, not ${CHAIN_ID}` }
  },
})

// 8. The queue. The lease is 120s because one tick may wait on a node and on custody in series.
const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId, leaseMs: 120_000 })

const dispense: DispenseDeps = {
  sql,
  rpc,
  custody,
  logger,
  metrics,
  fundingAddress: env.fundingAddress,
  chainId: CHAIN_ID,
  confirmations: CONFIRMATIONS,
  gasPriceWei: env.gasPriceWei,
  limits: env.limits,
  maxRecipientBalanceWei: env.limits.maxRecipientBalanceWei,
  reserveWei: env.limits.reserveWei,
}

// 9. Routes. After the Lifecycle so the health handlers report real state.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const refresh = scrapeRefresh({ sql, metrics, limits: env.limits })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql,
  token: env.token,
  chainId: CHAIN_ID,
  fundingAddress: env.fundingAddress,
  limits: env.limits,
  corsOrigins: parseOrigins(process.env['FAUCET_CORS_ORIGINS'] ?? ''),
  // Gauges are sampled at scrape time rather than on a timer. There is no `setInterval` in this
  // repository and CI greps for one — rule 8.
  beforeScrape: async () => {
    await refresh()
    await sampleQueue(queue, metrics)
  },
})

// 10. The job runner, started before `listen()`. Concurrency is 2 — one slot for the chain tick and
//     one for retention — and the chain tick's SAFETY comes from the lease and the in-flight index,
//     never from this number.
const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  concurrency: 2,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})
registerHandlers(runner, { dispense, logger, metrics, retentionDays: env.retentionDays })
await seedRecurring(queue)
runner.start()

// 11. Listen. Last of the construction steps: a socket that accepts before its dependencies exist
//     is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 12. Ready. Only now does `/readyz` start answering 200 and the balancer send traffic.
lifecycle.markReady()

// 13. Signal handlers, last of all. Hooks run in reverse registration order, so the server closes
//     first, then the runner stops claiming and DRAINS — which matters more here than anywhere: a
//     runner killed mid-tick between `markSigned` and the broadcast leaves a `signed` row, and
//     while the next replica recovers that correctly, draining means it does not have to.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)

/** An allowlist, never a wildcard. Empty means no browser may post, which is the default. */
function parseOrigins(raw: string): readonly string[] {
  return Object.freeze(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && entry !== '*')
      .map((entry) => {
        try {
          return new URL(entry).origin
        } catch {
          logger.warn('ignoring an unparseable CORS origin', { entry })
          return ''
        }
      })
      .filter((entry) => entry.length > 0),
  )
}
