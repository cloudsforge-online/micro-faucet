/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * The service this supersedes has no database at all. Its entire state is a JSON file
 * (`stack/repos/hearth/tools/faucet/src/limits.js:167-208`) held in one process's memory and
 * flushed on a debounced `setTimeout`. That is not a smaller version of this schema; it is a
 * different guarantee, and the difference is the whole repository.
 *
 * ---------------------------------------------------------------------------------------------
 * **THE FOUR CONSTRAINTS BELOW ARE THE SERVICE. Everything else is plumbing.**
 *
 *   `faucet_address_grants`   The per-address cooldown, as a ROW rather than as a `Map` entry.
 *                             The frozen limiter is `this.addresses = new Map()`
 *                             (`limits.js:55`), which is per-process by construction: with two
 *                             replicas behind one balancer every limit is doubled, with ten it is
 *                             tenfold, and no amount of care inside the process changes that. It
 *                             also resets on restart unless the JSON file survives, and "restart
 *                             the faucet" happens on every deploy. The cooldown here is a
 *                             conditional upsert (`limits.ts`), so N replicas and N connections
 *                             produce one grant.
 *
 *   `faucet_budget`           The global payout ceiling, one row, guarded by a CHECK that the
 *                             spend can never exceed the window's cap. The frozen equivalent is
 *                             an array scan (`limits.js:69-74`). This is the control that bounds
 *                             the loss and it is the one an attacker cannot get around by
 *                             generating more addresses, so it is stated by the database.
 *
 *   `dispenses_live_recipient_uniq`
 *                             ONE live dispense per recipient. A partial unique index over the
 *                             non-terminal states. It is what stops two simultaneous requests for
 *                             one address from both being accepted when they arrive on different
 *                             replicas in the same millisecond — the cooldown row settles the
 *                             SECOND request only after the first has committed, and this index
 *                             is what settles them when neither has.
 *
 *   `dispenses_in_flight_uniq`
 *                             ONE in-flight dispense on the chain, full stop. A partial unique
 *                             index on a constant expression over the states that hold a nonce.
 *                             **The contended resource is the funding address's nonce, not the
 *                             dispense row** — `settlement/src/worker.ts:8-18` is the same
 *                             sentence about the same class of bug, and it is why the lease in
 *                             `jobs.ts` is keyed on the chain rather than on the row. Two
 *                             different dispenses, each with its own row and its own perfectly
 *                             correct conditional update, both read `eth_getTransactionCount` and
 *                             both get the same answer. At most one can ever be mined. This index
 *                             is what stands when the lease has already failed.
 * ---------------------------------------------------------------------------------------------
 *
 * **EVERY WEI IS `numeric(78,0)`.** Not `bigint`, which is 64 bits and holds 9.22e18 — nine and a
 * bit whole EMBER at 18 decimals, so a budget of ten EMBER would overflow it. Not `double
 * precision`, which is the defect rule 4 of the brief names. 78 digits is uint256's decimal width.
 * `postgres.js` returns `numeric` as a string, which `BigInt()` parses exactly, and the round trip
 * never passes through a `Number`.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

/**
 * The states a dispense moves through, and the two sets that matter.
 *
 * The ladder is `queued → signing → signed → broadcast → confirmed`, plus `failed`. It is
 * `settlement`'s ladder because it is the same problem, and the ordering carries the same
 * correctness argument:
 *
 *   `queued`     accepted, budget reserved, nothing signed and no nonce read.
 *   `signing`    claimed by a worker holding the chain lease. A nonce is about to be read.
 *   `signed`     **THE BYTES ARE COMMITTED.** Nothing has been broadcast yet.
 *   `broadcast`  the node has the transaction, or had it and answered "already known".
 *   `confirmed`  mined to `CONFIRMATIONS` depth.
 *   `failed`     terminal, and reached only from a state that had signed nothing.
 *
 * A crash between `signing` and `signed` has broadcast nothing, so the signature is discarded
 * unbroadcast and the next tick starts from a fresh nonce read. A crash between `signed` and
 * `broadcast` leaves the bytes on the row and the worker RESUMES AT BROADCAST with the same bytes,
 * which is what makes a lost broadcast response safe: re-broadcasting identical bytes is the same
 * transaction with the same hash, and the node either accepts it or says it already has it. There
 * is no path anywhere from `signed` back to `queued`.
 */
export const LIVE_STATES: readonly string[] = Object.freeze(['queued', 'signing', 'signed', 'broadcast'])

/** The states that have consumed a nonce, or are about to. One of these exists at a time. */
export const IN_FLIGHT_STATES: readonly string[] = Object.freeze(['signing', 'signed', 'broadcast'])

const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ')

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'dispenses',
    up: `
      -- One request for EMBER, from acceptance to confirmation. The service's only ledger.
      create table if not exists dispenses (
        id                uuid        primary key default gen_random_uuid(),
        -- Lower case, always. See addressKey() in address.ts: the uniqueness guarantees below are
        -- worth exactly as much as the spelling is consistent.
        recipient         text        not null,
        -- Who asked. An authenticated subject where there is one, otherwise the client address.
        -- Never trusted for authorisation — see limits.ts on what a requester actually bounds.
        requester         text        not null,
        status            text        not null default 'queued',
        -- The payout. Fixed by configuration at the moment of acceptance and STORED, so that a
        -- deploy that changes FAUCET_DRIP_EMBER does not retroactively change what a queued
        -- request is owed. numeric(78,0), never a float: rule 4.
        amount_wei        numeric(78,0) not null,
        chain_id          integer     not null,

        -- The idempotency fingerprint. Two requests with the same one are the same request.
        -- EXCLUDES every per-attempt field — see fingerprint.ts, and ledger/src/idempotency.test.ts
        -- for the sibling that states the rule.
        fingerprint       text        not null,

        -- Filled by the worker, in this order, each in its own committed step.
        nonce             bigint,
        raw_tx            text,
        tx_hash           text,
        custody_audit_id  text,
        confirmations     integer     not null default 0,
        block_number      bigint,

        -- Why it failed, for the operator. Never a key, never a signature: see scrub in server.ts.
        failure_reason    text,

        created_at        timestamptz not null default now(),
        updated_at        timestamptz not null default now(),
        signed_at         timestamptz,
        broadcast_at      timestamptz,
        settled_at        timestamptz,

        constraint dispenses_status_known
          check (status in ('queued','signing','signed','broadcast','confirmed','failed')),
        -- Lower case at the column, so no future write path can reintroduce a second spelling of
        -- one account and with it a second cooldown.
        constraint dispenses_recipient_shape check (recipient ~ '^0x[0-9a-f]{40}$'),
        constraint dispenses_amount_positive check (amount_wei > 0),
        -- A dispense past 'signing' MUST carry the bytes. This is the exactly-once property stated
        -- by the database: a 'broadcast' row with no raw_tx would be a transaction this service
        -- could neither identify nor re-broadcast, so the recovery path would have to sign again.
        constraint dispenses_signed_has_bytes
          check (status not in ('signed','broadcast','confirmed')
                 or (raw_tx is not null and tx_hash is not null and nonce is not null)),
        constraint dispenses_confirmed_has_block
          check (status <> 'confirmed' or (block_number is not null and settled_at is not null)),
        constraint dispenses_failed_has_reason
          check (status <> 'failed' or failure_reason is not null),
        constraint dispenses_confirmations_nonneg check (confirmations >= 0),
        constraint dispenses_tx_hash_shape check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$')
      );

      -- ONE LIVE DISPENSE PER RECIPIENT. The second of two simultaneous requests for one address
      -- loses here when it has not already lost on the cooldown row.
      create unique index if not exists dispenses_live_recipient_uniq
        on dispenses (recipient)
        where status in (${sqlList(LIVE_STATES)});

      -- ONE IN-FLIGHT DISPENSE ON THE CHAIN. The constant expression is deliberate: this service
      -- funds from one address on one chain, so the contended resource is global. Written as
      -- (chain_id) rather than ((true)) so that a second chain would be a schema change somebody
      -- has to think about rather than a silent widening.
      create unique index if not exists dispenses_in_flight_uniq
        on dispenses (chain_id)
        where status in (${sqlList(IN_FLIGHT_STATES)});

      -- Retried idempotently: the same fingerprint is the same request, whatever its outcome.
      create unique index if not exists dispenses_fingerprint_uniq on dispenses (fingerprint);

      create index if not exists dispenses_recipient_created_idx on dispenses (recipient, created_at desc);
      create index if not exists dispenses_status_created_idx    on dispenses (status, created_at);
      create index if not exists dispenses_tx_hash_idx           on dispenses (tx_hash) where tx_hash is not null;
    `,
  },
  {
    version: 3,
    name: 'limits',
    up: `
      -- THE PER-ADDRESS COOLDOWN, AS A ROW. The frozen service's Map, made shared.
      --
      -- One row per address that has ever been granted, holding the moment of the last grant. The
      -- reservation is a conditional upsert whose WHERE clause is the cooldown; see limits.ts.
      create table if not exists faucet_address_grants (
        recipient       text        primary key,
        last_granted_at timestamptz not null,
        grants          bigint      not null default 1,
        constraint faucet_address_grants_shape  check (recipient ~ '^0x[0-9a-f]{40}$'),
        constraint faucet_address_grants_counts check (grants > 0)
      );

      -- THE PER-REQUESTER WINDOW. Same mechanism, plus a count that resets when the window rolls.
      --
      -- Weak on its own and known to be — an IPv6 /64 has 2^64 addresses and residential proxies
      -- are sold by the hour, which the frozen service says at limits.js:9-11 and which is still
      -- true. It stops the lazy case at the cost of one row. The budget below is what actually
      -- bounds the loss.
      create table if not exists faucet_requester_grants (
        requester         text        primary key,
        window_started_at timestamptz not null,
        grants            integer     not null,
        last_granted_at   timestamptz not null,
        constraint faucet_requester_grants_counts check (grants > 0)
      );

      -- THE BUDGET. One row, and the reason a drained faucet is a bounded loss.
      --
      -- "spent_wei <= cap_wei" is a CHECK rather than a rule in application code, so the ceiling
      -- holds against every writer including a future one and including an operator with psql. A
      -- limiter that can be talked past by a second code path is not a limiter.
      create table if not exists faucet_budget (
        id                smallint    primary key default 1,
        window_started_at timestamptz not null default now(),
        spent_wei         numeric(78,0) not null default 0,
        cap_wei           numeric(78,0) not null,
        constraint faucet_budget_singleton check (id = 1),
        constraint faucet_budget_nonneg    check (spent_wei >= 0),
        constraint faucet_budget_within_cap check (spent_wei <= cap_wei)
      );
    `,
  },
]

/** Every table this service owns. The truncate list for the test harness, and nothing else. */
export const TABLES: readonly string[] = Object.freeze([
  'dispenses',
  'faucet_address_grants',
  'faucet_requester_grants',
  'faucet_budget',
])

/**
 * The version `index.ts` asserts before it serves.
 *
 * Derived rather than written down, so adding a migration cannot leave the assertion behind — the
 * failure that produces is a service running happily against a schema missing the CHECK it depends
 * on, which is silent until the day it matters.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
)

/**
 * No baseline. The service this supersedes has no database — its state is a JSON file on one
 * container's volume — so there is nothing to adopt and migration 2 runs on an empty schema.
 */
export const BASELINE_VERSION = 0
