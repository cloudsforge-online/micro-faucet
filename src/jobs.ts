/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no `setInterval`
 * in this repository doing domain work, and CI greps for one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE LEASE KEY NAMES THE CHAIN, NOT THE DISPENSE.** `chain.dispense` is keyed `ember:testnet`
 * and there is exactly ONE such row for every replica in the estate to contend over. That is the
 * whole design and it is the thing most likely to be got wrong by someone extending this:
 *
 *     kind             key             why
 *     chain.dispense   ember:testnet   The contended resource is the funding address's NONCE.
 *                                      Keying on the dispense row would let two different
 *                                      dispenses sign against one nonce, which is
 *                                      settlement/src/worker.ts:8-18 exactly.
 *     retention        global          One prune, however many replicas.
 *
 * `@cloudsforge/jobs` claims with `for update skip locked`, so of N workers polling for
 * `chain.dispense / ember:testnet` exactly one gets it and the rest skip rather than wait.
 *
 * The frozen service has no queue and no lease. Its serialisation is `Sender._serialise`
 * (`stack/repos/hearth/tools/faucet/src/sender.js:56-62`), a module-scope promise chain, and its
 * only timer is the limiter's debounced state flush (`limits.js:188`). Both are per-process, so
 * both are invisible to a second replica.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The dispense job is recurring rather than enqueued per request. A per-request job would be a
 * second queue keyed on the row, which is the keying this file exists to avoid — and the tick has
 * to run anyway to advance confirmations on a dispense nobody is asking about.
 */

import { type JobQueue, type JobRunner, type RunnerEvent } from '@cloudsforge/jobs'
import type { Db } from './db.ts'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { driveChain, type DispenseDeps } from './dispense.ts'
import { requesterEpoch, type RequesterConfig } from './requester.ts'

export const DISPENSE_KIND = 'chain.dispense'
export const RETENTION_KIND = 'retention'

/** The lease key. One chain, one network, one nonce, one row. */
export const CHAIN_KEY = 'ember:testnet'

export interface Recurring {
  readonly kind: string
  readonly key: string
  readonly everyMs: number
}

export const RECURRING: readonly Recurring[] = Object.freeze([
  // Two seconds. Fast enough that a drip feels immediate and slow enough that an idle faucet is
  // not polling a node thirty times a minute for nothing.
  { kind: DISPENSE_KIND, key: CHAIN_KEY, everyMs: 2_000 },
  { kind: RETENTION_KIND, key: 'global', everyMs: 3_600_000 },
])

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue): Promise<void> {
  for (const job of RECURRING) {
    await queue.enqueue({ kind: job.kind, key: job.key, onConflict: 'keep', payload: {} })
  }
}

/**
 * Re-arm a recurring job from its completion event — the only moment the row is gone. A
 * dead-lettered recurring job is deliberately NOT re-armed: the row stays, `jobs_dead_total`
 * climbs, and that is how an operator learns that the thing dispensing EMBER has stopped.
 */
export function rescheduleRecurring(queue: JobQueue, logger: Logger): (event: RunnerEvent) => void {
  const byKey = new Map(RECURRING.map((job) => [`${job.kind} ${job.key}`, job]))
  return (event) => {
    if (event.type !== 'completed' || !event.kind || !event.key) return
    const job = byKey.get(`${event.kind} ${event.key}`)
    if (!job) return
    void queue
      .enqueue({
        kind: job.kind,
        key: job.key,
        runAt: new Date(Date.now() + job.everyMs),
        onConflict: 'earliest',
        payload: {},
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: job.kind, err }))
  }
}

export interface JobDeps {
  readonly dispense: DispenseDeps
  readonly logger: Logger
  readonly metrics: Metrics
  readonly retentionDays: number
  /** The requester counters' retention period. See `requester.ts` and `pruneRequesters` below. */
  readonly requester: RequesterConfig
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  /* ---------------------------------------------------------------- chain.dispense */

  runner.register(DISPENSE_KIND, async (_job, ctx) => {
    // `heartbeat` is passed through to `driveChain`, which calls it between steps. A tick that
    // waits on a slow node must extend its lease or a second worker will take the chain while the
    // first is still holding a nonce.
    const result = await driveChain(deps.dispense, ctx.heartbeat)
    if (result.advanced || result.started || result.retired.length > 0) {
      deps.logger.info('chain tick', {
        advanced: result.advanced,
        started: result.started,
        retired: result.retired.length,
      })
    }
  })

  /* ---------------------------------------------------------------- retention */

  runner.register(RETENTION_KIND, async () => {
    const pruned = await pruneSettled(deps.dispense.sql, deps.retentionDays)
    if (pruned > 0) deps.logger.info('pruned settled dispenses', { pruned })

    // The other half of retention, and the one with a regulator behind it. Runs on the SAME tick
    // as the dispense prune so there is one recurring job to keep alive rather than two, and so an
    // operator watching `jobs_dead_total` for `retention` is watching both.
    const requesters = await pruneRequesters(deps.dispense.sql, deps.requester.retentionSeconds)
    if (requesters > 0) {
      // A count and an epoch. Never a requester key, which is pseudonymous but is still a
      // per-network identifier, and never anything derived from an address.
      deps.logger.info('pruned requester counters', {
        pruned: requesters,
        epoch: requesterEpoch(deps.requester.retentionSeconds),
        retentionSeconds: deps.requester.retentionSeconds,
      })
    }
  })

  return runner
}

/**
 * Delete settled dispenses past their horizon.
 *
 * Only `confirmed` and `failed`, and only on `settled_at`. A live row is never pruned however old
 * it is: a dispense stuck in `broadcast` for a week is the single most important row in the
 * database, because it is a signed transaction whose fate nobody knows, and deleting it would
 * destroy the only record that it exists.
 *
 * `faucet_address_grants` is NOT pruned here, and that is deliberate. A grant row is what the
 * cooldown is made of, and deleting one hands its address a fresh drip. It holds an EMBER address,
 * which is public on chain and is not a person — so the argument that forces `pruneRequesters`
 * below to exist does not reach it.
 */
export async function pruneSettled(sql: Db, days: number): Promise<number> {
  const result = await sql`
    delete from dispenses
     where status in ('confirmed','failed')
       and settled_at < now() - make_interval(days => ${days})
  `
  return (result as unknown as { count?: number }).count ?? 0
}

/**
 * Enforce the requester counters' retention period. **This is the erasure, and it runs.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A retention policy that nothing executes is a comment. `faucet_requester_grants` had one for
 * exactly as long as it had a primary key made of IP addresses — which is to say it had none, and
 * nothing in the repository said so. This is the recurring job that makes the period in
 * `env.ts` a fact about the database rather than a claim in a document. micro-org#163.
 *
 * It is registered on the EXISTING `retention` recurring job (RECURRING, above), which is claimed
 * by `@cloudsforge/jobs` with `for update skip locked` and re-armed from its completion event —
 * rule 8, no `setInterval` doing domain work, and CI greps for one. A dead-lettered retention job
 * is not re-armed, so a prune that has stopped running climbs `jobs_dead_total` and is visible
 * rather than silently absent.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ON `window_started_at` RATHER THAN `last_granted_at`, and it matters. The window start is when
 * the counter this row represents began; the last grant only moves within it. Deleting on the
 * window start bounds the row by the thing it is counting, and it is the column
 * `faucet_requester_grants_window_idx` covers.
 *
 * Every row this deletes is already unusable: `env.ts` refuses a retention period shorter than
 * `FAUCET_REQUESTER_WINDOW_SECONDS`, so a row past the horizon is a row whose window rolled long
 * ago, and the next reservation from that requester would have reset it to 1 anyway. **Nothing is
 * lost and nobody gains a drip** — which is why this is a plain delete and not a decision.
 *
 * Belt and braces with the salt rotation: rotation makes an old row unreachable, this makes it
 * absent. Unreachable is not erased, and Art. 5(1)(e) is about the second one.
 */
export async function pruneRequesters(sql: Db, retentionSeconds: number): Promise<number> {
  const result = await sql`
    delete from faucet_requester_grants
     where window_started_at < now() - make_interval(secs => ${retentionSeconds})
  `
  return (result as unknown as { count?: number }).count ?? 0
}

/** Refresh the queue-depth gauges. Called at scrape time, never on a timer. */
export async function sampleQueue(queue: JobQueue, metrics: Metrics): Promise<void> {
  const stats = await queue.stats()
  metrics.set('jobs_pending', stats.pending)
  metrics.set('jobs_overdue', stats.overdue)
}
