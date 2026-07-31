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
 * cooldown is made of, and deleting one hands its address a fresh drip.
 */
export async function pruneSettled(sql: Db, days: number): Promise<number> {
  const result = await sql`
    delete from dispenses
     where status in ('confirmed','failed')
       and settled_at < now() - make_interval(days => ${days})
  `
  return (result as unknown as { count?: number }).count ?? 0
}

/** Refresh the queue-depth gauges. Called at scrape time, never on a timer. */
export async function sampleQueue(queue: JobQueue, metrics: Metrics): Promise<void> {
  const stats = await queue.stats()
  metrics.set('jobs_pending', stats.pending)
  metrics.set('jobs_overdue', stats.overdue)
}
