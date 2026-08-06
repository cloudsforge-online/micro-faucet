/**
 * The rate limiter, and the reason the faucet cannot be drained.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY LIMIT HERE IS ENFORCED BY THE DATABASE. AN IN-MEMORY LIMITER IS PER-REPLICA AND IS
 * THEREFORE NOT A LIMITER.**
 *
 * The frozen service's limiter is three JavaScript `Map`s and an array
 * (`stack/repos/hearth/tools/faucet/src/limits.js`), and its own header makes a careful,
 * correct argument for why that is safe (`limits.js`): `reserve()` performs every check AND
 * records the spend in one synchronous block with no `await` inside it, so on Node's single thread
 * two simultaneous requests for the same address cannot both pass. That argument is true. It is
 * also true of exactly one process. Behind a balancer with two replicas every limit is doubled;
 * with ten it is tenfold; and the daily cap — the control the file correctly identifies as "the one
 * that means anything" — becomes ten daily caps. Nothing inside the process can fix that, because
 * the other replica is not inside the process.
 *
 * The persistence does not save it either. State is a JSON file flushed on a debounced
 * `setTimeout` (`limits.js`), so N replicas on one volume overwrite each other's view of
 * the limits, and each write is a whole-file replacement of a state another process has since
 * changed. Two replicas sharing that file is worse than two replicas not sharing it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The four controls, and what each one is actually worth
 *
 *   per address   an honest user's only encounter with any of this.
 *                 Bypass: generate another address. Free and instant.
 *   per requester stops the lazy script. Bypass: an IPv6 /64 has 2^64 addresses, and residential
 *                 proxies are sold by the hour.
 *   recipient     refuse anyone who already holds enough. Bypass: sweep the drip to a cold
 *   balance      address between requests. Lives in `dispense.ts` — it needs the node.
 *   THE BUDGET    no bypass. However many addresses, however many requesters, however fast, the
 *                 faucet pays out at most `cap_wei` per rolling window and then refuses everyone.
 *
 * The budget is the one that means anything. The other three exist so that an honest user is never
 * the one who trips it. That framing is the frozen service's (`limits.js`) and it is right;
 * what is different here is only where the counters live.
 *
 * ## How a reservation is atomic without a lock
 *
 * Each of the three is a single conditional statement whose WHERE clause IS the limit, and whose
 * affected-row count is the answer. `on conflict … do update … where <the limit still permits it>`
 * is evaluated by Postgres under the row lock the conflict already took, so two concurrent
 * transactions serialise on it and exactly one sees the pre-update value. No `select` first, no
 * read-modify-write, and therefore no window between the check and the record — which is the
 * classic faucet drain, and which looks completely correct in review.
 *
 * The three run inside ONE transaction, so a request that passes the address cooldown and then
 * fails the budget consumes neither. `reserve` takes a `Tx` and never opens its own.
 */

import type { Db, Tx } from './db.ts'
import { addressKey } from './address.ts'


export type RefusalCode =
  | 'address_cooldown'
  | 'requester_limit'
  | 'budget_exhausted'

export interface Refusal {
  readonly ok: false
  readonly code: RefusalCode
  readonly message: string
  /** Seconds. Served as `retry-after`, so it is never zero and never negative. */
  readonly retryAfterSeconds: number
}

export type Reservation = { readonly ok: true } | Refusal

export interface LimitConfig {
  readonly dripWei: bigint
  readonly addressCooldownSeconds: number
  readonly requesterLimit: number
  readonly requesterWindowSeconds: number
  readonly budgetWei: bigint
  readonly budgetWindowSeconds: number
}

/** postgres.js reports the affected-row count on a write. One means the statement took effect. */
function affected(result: unknown): number {
  const count = (result as { count?: number } | undefined)?.count
  return typeof count === 'number' ? count : 0
}

/** `numeric` arrives as a string; `BigInt` parses it exactly. Never through a `Number`. */
function wei(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string') {
    // BigInt('') is 0n — an empty string parses to a confident zero, silently. Postgres never
    // sends an empty numeric, so this is a guard against the OTHER sources this function's
    // signature admits, and against the day someone reuses it on a request body.
    // micro-network-site found the identical hole in its own inherited client by driving it.
    if (!/^-?\d+$/.test(value)) throw new TypeError(`not a wei amount: ${JSON.stringify(value)}`)
    return BigInt(value)
  }
  if (typeof value === 'number') {
    // Reachable only if the driver's numeric parser is reconfigured. Refused rather than rounded:
    // a wei amount that has been through a double is a wei amount that is quietly wrong.
    throw new TypeError(`a wei amount arrived as a number (${value}) — it must stay exact`)
  }
  throw new TypeError(`cannot read a wei amount from ${typeof value}`)
}

/**
 * Take a slot for one drip, or say why not. **Call inside a transaction.**
 *
 * The order is cheapest-and-most-specific first, so the message a user gets names the limit they
 * actually hit rather than the last one checked.
 */
export async function reserve(
  tx: Tx,
  input: { readonly recipient: string; readonly requester: string },
  config: LimitConfig,
): Promise<Reservation> {
  /*
   * ALL-OR-NOTHING IS A PROPERTY OF THIS FUNCTION, NOT OF WHAT THE CALLER DOES NEXT.
   *
   * The three statements below run in order and any of them may refuse, so a request that passes
   * the cooldown and then fails the budget has already written a grant row. Leaving that behind
   * would bar an address for a day over a limit it did not break — it never got a drip — and the
   * bar would be invisible, because nothing else in the system knows the grant was speculative.
   *
   * A SAVEPOINT is what makes the guarantee independent of the caller. `acceptDrip` happens to
   * throw on a refusal, which rolls the outer transaction back and would have hidden this; a
   * future caller that simply reads the returned `Refusal` and commits would not. The rollback
   * belongs here, where the partial write happens.
   *
   * `RefusedInternally` is private and never escapes: it exists only to make `savepoint` roll
   * back, which it does by catching a throw.
   */
  let outcome: Reservation = { ok: true }
  try {
    await tx.savepoint(async (sp) => {
      outcome = await attempt(sp as unknown as Tx, input, config)
      if (!outcome.ok) throw new RefusedInternally()
    })
  } catch (err) {
    if (!(err instanceof RefusedInternally)) throw err
  }
  return outcome
}

/** Private. Rolls the savepoint back and is swallowed by `reserve`; no caller ever sees it. */
class RefusedInternally extends Error {}

/** The three statements, in order. Called only from `reserve`, only inside its savepoint. */
async function attempt(
  tx: Tx,
  input: { readonly recipient: string; readonly requester: string },
  config: LimitConfig,
): Promise<Reservation> {
  const recipient = addressKey(input.recipient)

  /* ── 1. The per-address cooldown ──────────────────────────────────────────────────────────
   *
   * Insert, or update only if the last grant is older than the cooldown. The WHERE clause on the
   * DO UPDATE is the limit itself: when it is false Postgres reports zero rows affected and the
   * address is still inside its cooldown. There is no read to race against.
   */
  const address = await tx`
    insert into faucet_address_grants (recipient, last_granted_at, grants)
    values (${recipient}, now(), 1)
    on conflict (recipient) do update
       set last_granted_at = now(),
           grants = faucet_address_grants.grants + 1
     where faucet_address_grants.last_granted_at
             < now() - make_interval(secs => ${config.addressCooldownSeconds})
  `
  if (affected(address) === 0) {
    const [row] = (await tx`
      select ceil(extract(epoch from
               (last_granted_at + make_interval(secs => ${config.addressCooldownSeconds})) - now()
             ))::bigint as seconds
        from faucet_address_grants
       where recipient = ${recipient}
    `) as ReadonlyArray<{ seconds: string | number }>
    return {
      ok: false,
      code: 'address_cooldown',
      message: `this address was funded within the last ${config.addressCooldownSeconds}s; one drip per address per window`,
      retryAfterSeconds: retryAfter(row?.seconds, config.addressCooldownSeconds),
    }
  }

  /* ── 2. The per-requester window ──────────────────────────────────────────────────────────
   *
   * Two conditions, either of which permits the grant: the window has rolled (reset the count) or
   * the count is still under the limit (increment it). Both are in the one statement, so a
   * requester whose window rolls between the two checks cannot be double-counted.
   */
  const requester = await tx`
    insert into faucet_requester_grants (requester, window_started_at, grants, last_granted_at)
    values (${input.requester}, now(), 1, now())
    on conflict (requester) do update
       set window_started_at = case
             when faucet_requester_grants.window_started_at
                    < now() - make_interval(secs => ${config.requesterWindowSeconds})
             then now() else faucet_requester_grants.window_started_at end,
           grants = case
             when faucet_requester_grants.window_started_at
                    < now() - make_interval(secs => ${config.requesterWindowSeconds})
             then 1 else faucet_requester_grants.grants + 1 end,
           last_granted_at = now()
     where faucet_requester_grants.window_started_at
             < now() - make_interval(secs => ${config.requesterWindowSeconds})
        or faucet_requester_grants.grants < ${config.requesterLimit}
  `
  if (affected(requester) === 0) {
    const [row] = (await tx`
      select ceil(extract(epoch from
               (window_started_at + make_interval(secs => ${config.requesterWindowSeconds})) - now()
             ))::bigint as seconds
        from faucet_requester_grants
       where requester = ${input.requester}
    `) as ReadonlyArray<{ seconds: string | number }>
    return {
      ok: false,
      code: 'requester_limit',
      message: `this requester has taken ${config.requesterLimit} drips; that is the limit per ${config.requesterWindowSeconds}s`,
      retryAfterSeconds: retryAfter(row?.seconds, config.requesterWindowSeconds),
    }
  }

  /* ── 3. THE BUDGET ────────────────────────────────────────────────────────────────────────
   *
   * The row is created on first use with the configured cap. `cap_wei` is refreshed on every
   * reservation so that lowering the cap in a deploy takes effect immediately — raising it does
   * too, which is intended: the cap is an operator's statement of what they are willing to lose
   * today, and it should not need a restart or a manual UPDATE to change.
   *
   * The WHERE clause is the ceiling, and `faucet_budget_within_cap` is the same statement made by
   * the schema. Both, deliberately: the clause is what refuses the request cleanly, and the CHECK
   * is what refuses it when some future write path forgets the clause.
   */
  const cap = config.budgetWei.toString(10)
  const amount = config.dripWei.toString(10)
  const budget = await tx`
    insert into faucet_budget (id, window_started_at, spent_wei, cap_wei)
    values (1, now(), ${amount}::numeric, ${cap}::numeric)
    on conflict (id) do update
       set window_started_at = case
             when faucet_budget.window_started_at
                    < now() - make_interval(secs => ${config.budgetWindowSeconds})
             then now() else faucet_budget.window_started_at end,
           spent_wei = case
             when faucet_budget.window_started_at
                    < now() - make_interval(secs => ${config.budgetWindowSeconds})
             then ${amount}::numeric else faucet_budget.spent_wei + ${amount}::numeric end,
           cap_wei = ${cap}::numeric
     where faucet_budget.window_started_at
             < now() - make_interval(secs => ${config.budgetWindowSeconds})
        or faucet_budget.spent_wei + ${amount}::numeric <= ${cap}::numeric
  `
  if (affected(budget) === 0) {
    const [row] = (await tx`
      select ceil(extract(epoch from
               (window_started_at + make_interval(secs => ${config.budgetWindowSeconds})) - now()
             ))::bigint as seconds
        from faucet_budget where id = 1
    `) as ReadonlyArray<{ seconds: string | number }>
    return {
      ok: false,
      code: 'budget_exhausted',
      // The wording matters and it is the frozen service's point (`limits.js`): the faucet
      // is NOT dry. Its balance may be perfect. It is rate limited in aggregate, which is a
      // different condition with a different fix, and telling an operator "dry" costs them an hour.
      message: 'the faucet has reached its payout cap for this window; it is rate limited, not empty',
      retryAfterSeconds: retryAfter(row?.seconds, config.budgetWindowSeconds),
    }
  }

  return { ok: true }
}

/**
 * Give a reservation back. **Only for work that never left the building.**
 *
 * Called when a dispense fails having signed and broadcast NOTHING — a custody refusal, a node
 * that would not take the transaction, an exhausted retry on an unsigned row. It is deliberately
 * NOT called for a transaction that was broadcast and then did not confirm: those bytes may yet be
 * mined, and the EMBER is genuinely gone. The frozen service draws the same line for the same
 * reason (`limits.js`) and it is the right one.
 *
 * The address grant is DELETED rather than rewound, which restores the pre-request state exactly:
 * `grants` was incremented and `last_granted_at` moved, and there is nowhere to move it back to.
 * That is correct for a first request and slightly generous for a repeat one, which is the safe
 * direction — the alternative is locking an honest user out for a day over somebody else's outage.
 */
export async function release(
  tx: Tx,
  input: { readonly recipient: string; readonly requester: string; readonly amountWei: bigint },
): Promise<void> {
  const recipient = addressKey(input.recipient)
  await tx`delete from faucet_address_grants where recipient = ${recipient}`
  await tx`
    update faucet_requester_grants
       set grants = grants - 1
     where requester = ${input.requester} and grants > 1
  `
  await tx`delete from faucet_requester_grants where requester = ${input.requester} and grants <= 1`
  // greatest(0, …) rather than a bare subtraction: `faucet_budget_nonneg` would abort the whole
  // transaction on a double release, and a release is a cleanup path that must not itself fail.
  await tx`
    update faucet_budget
       set spent_wei = greatest(0::numeric, spent_wei - ${input.amountWei.toString(10)}::numeric)
     where id = 1
  `
}

export interface BudgetState {
  readonly spentWei: bigint
  readonly capWei: bigint
  readonly remainingWei: bigint
  readonly windowStartedAt: Date
}

/** What is left in this window. Read-only, for `/readyz` and the operator surface. */
export async function budgetState(sql: Db, config: LimitConfig): Promise<BudgetState> {
  const [row] = (await sql`
    select window_started_at, spent_wei, cap_wei
      from faucet_budget
     where id = 1
       and window_started_at >= now() - make_interval(secs => ${config.budgetWindowSeconds})
  `) as ReadonlyArray<{ window_started_at: Date; spent_wei: string; cap_wei: string }>

  // No row, or a row whose window has rolled: the next reservation resets it, so the honest answer
  // now is a full budget. Reporting the stale spend would show a faucet as exhausted for as long
  // as nobody asked it for anything.
  if (!row) {
    return {
      spentWei: 0n,
      capWei: config.budgetWei,
      remainingWei: config.budgetWei,
      windowStartedAt: new Date(),
    }
  }
  const spentWei = wei(row.spent_wei)
  const capWei = wei(row.cap_wei)
  return {
    spentWei,
    capWei,
    remainingWei: capWei > spentWei ? capWei - spentWei : 0n,
    windowStartedAt: row.window_started_at,
  }
}

/** Never zero, never negative, never past the window it came from. */
function retryAfter(raw: unknown, windowSeconds: number): number {
  const seconds = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(seconds)) return windowSeconds
  return Math.min(windowSeconds, Math.max(1, Math.ceil(seconds)))
}
