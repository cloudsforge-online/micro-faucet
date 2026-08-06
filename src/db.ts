/**
 * The two database handles, named once.
 *
 * `@cloudsforge/db` exports a deliberately narrow `Sql` — a tagged template and `unsafe`, plus an
 * optional `reserve` that migrations need — and that narrowness is right for a package that must
 * not care which driver it is handed. It has no `begin`, so it cannot express a transaction, and
 * the reservation in `limits.ts` is only atomic BECAUSE it runs inside one.
 *
 * So the domain modules take `postgres`'s own types, exactly as `settlement/src/outbox.ts`
 * does and for the same reason. `Db` is structurally a superset of `@cloudsforge/db`'s `Sql`, so
 * the same pool satisfies `migrate` and `assertSchemaAtLeast` with the cast `index.ts` already
 * makes.
 *
 * `Tx` is distinct from `Db` on purpose. A function that takes a `Tx` is saying it must be called
 * inside a transaction and cannot open its own — which is the whole contract of `reserve` and
 * `release`, and a contract worth having the compiler enforce rather than a comment.
 */

import type { Sql, TransactionSql } from 'postgres'

/** A pool. May start a transaction. */
export type Db = Sql

/** Inside a transaction. Cannot start another, and must not need to. */
export type Tx = TransactionSql
