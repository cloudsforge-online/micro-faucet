# micro-faucet

[![ci](https://github.com/cloudsforge-online/micro-faucet/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-faucet/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml) [![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

The testnet EMBER faucet. It hands out worthless coins on the Hearth testnet so that a developer
with an empty address can deploy something.

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

It is also **an abuse target that signs transactions**, and everything below follows from that.

---

## The inherited claim, checked

`docs/ecosystem/02-target-architecture.md:436` says the faucet is "built and tested and **not
deployed**", and `docs/ecosystem/00-current-state.md:312` puts a number on it: "Built, undeployed —
`hearth/tools/faucet`, 66 checks, not in compose."

**Both are true.** The source is fourteen files in `stack/repos/hearth/tools/faucet`, and
`node test/faucet.test.js` reports `66 passed, 0 failed` — 66 assertions across 16 groups in a
zero-dependency harness, run over real HTTP against a stub JSON-RPC node. It is genuinely good work:
the transaction codec is the node's own rather than hand-rolled RLP, the drip is a server-side
constant, the limiter's atomicity argument is correct, and the two RPC error messages that name
Hearth's UTXO-era REST API are earned experience.

Two corrections to the record:

* **The document the brief cited does not exist.** There is no
  `docs/ecosystem/03-repository-responsibilities.md` in `stack/` — the `docs/ecosystem` directory
  holds exactly three files, `00-current-state.md`, `01-product-vision.md` and
  `02-target-architecture.md`. The claim is real; the citation was not.

* **The frozen faucet's default chain id is EMBER MAINNET.**
  `stack/repos/hearth/tools/faucet/src/env.js:94` reads
  `chainId: num(process.env.HEARTH_CHAIN_ID, 7411)`, and `.env.example:25` ships `HEARTH_CHAIN_ID=7411`.
  `@cloudsforge/contracts-chain` (`contracts/packages/chain/src/index.ts:57`) pins EMBER at
  `{ mainnet: 7411, testnet: 7412 }`. The boot check at `src/index.js:71-75` compares the node's
  `eth_chainId` against that configured value, so it verifies **agreement, not identity** — point it
  at a mainnet node and every check passes, because the two agree perfectly. The local Hearth testnet
  node answers `eth_chainId` with `0x1cf4` = 7412, so the shipped configuration does not even match
  the testnet it is for.

---

## What was ported, and what was rewritten

**Ported, because the frozen version is right** — each carries a `path:line` comment at its site.

| Here | From | Why it survived |
|---|---|---|
| `src/address.ts` | `src/address.js:14-48` | The EIP-55 rule is exactly right: a mixed-case address is claiming a checksum and is held to it; an all-one-case address is not claiming one and is accepted. The `ember1…` refusal is kept verbatim, wording included. |
| `src/rpc.ts` | `src/rpc.js` | Strict hex QUANTITY in both directions, and the two error messages that name the UTXO-era REST API — the most common misconfiguration, reconfirmed against the running node. |
| `src/env.ts` (`emberToWei`) | `src/env.js:19-25` | 18-decimal parsing without floating point, split on the point and right-padded. |
| The refusal ordering | `src/server.js:12-16` | Cheapest-first: parse, then the free local rules, then anything that costs a round trip. |
| The four-layer limit argument | `src/limits.js:5-18` | "The global cap is the one that means anything. The other three exist so that an honest user is never the one who trips it." Correct, and kept. |
| The fixed drip | `src/server.js:187-188` | "Every faucet that has ever been drained let the caller influence the amount." |
| "Rate limited, not dry" | `src/limits.js:115-117` | Telling an operator "dry" when the balance is fine costs them an hour. |
| Boot leniency for an absent node | `src/index.js:88-94` | Fatal only on a chain-id mismatch. See "The chain check" below — the frozen service is right on this specific point, for a reason worth writing down. |

**Rewritten, with the defect each rewrite closes.**

| Here | Replaces | The defect |
|---|---|---|
| `faucet_address_grants`, `faucet_requester_grants`, `faucet_budget` (`src/migrations.ts`, `src/limits.ts`) | `src/limits.js:55-59`, three `Map`s and an array | **An in-memory limiter is per-replica and is therefore not a limiter.** The frozen file's own atomicity argument (`limits.js:20-25`) is sound — and about one process. Two replicas double every limit including the daily cap; ten make it tenfold. The JSON-file persistence (`limits.js:182-195`) makes it worse, not better: N replicas on one volume whole-file-overwrite each other's view. |
| The chain-keyed lease (`src/jobs.ts`, `src/dispense.ts`) | `Sender._serialise`, `src/sender.js:56-62` | A module-scope promise chain the second replica cannot see. `settlement/src/worker.ts:8-18` is the same class of bug: **the contended resource is the funding address's nonce, not the dispense row.** |
| `queued → signing → signed → broadcast → confirmed` with the bytes committed before the broadcast | `handleDrip`, `src/server.js:174-258` | The frozen service broadcasts inside the request handler and answers 200 with a hash. A client that times out and retries has caused a broadcast it will never learn about; and nothing tracks confirmation, so a transaction dropped from the mempool is a drip the faucet believes it made. |
| Custody holds the key (`src/custodyclient.ts`) | `src/env.js:41-83` | A 32-byte scalar in the process environment, which is why that file is three quarters comments about how keys leak. |
| The testnet gate (`src/env.ts`) | `src/env.js:94`, `src/index.js:71-75` | See above: agreement, not identity, defaulting to mainnet. |
| `/livez`, `/readyz`, `/metrics` | `GET /health`, `src/server.js:130-151` | One route for three questions, answering 503 when the faucet is dry — so an empty faucet is pulled out of the balancer and the page that would have said "the faucet is out of EMBER" is unreachable. |
| `src/migrator.ts`, a one-shot job | *(nothing — the frozen service has no database)* | |

`src/keccak.ts` is carried across from `settlement/src/keccak.ts` unchanged, so two services deriving
the same address cannot disagree. The frozen module reached into the node's source tree with
`require('../../../node/src/crypto/keccak')` (`address.js:11`), which is why its Dockerfile has to
build from the whole Hearth repository root and hand-copy six paths out of it — and why the service
was never deployable on its own.

---

## Where the key lives, and why

**In `micro-custody`. This process holds no key material and has no variable that would accept
any.** `src/env.test.ts` proves that by absence: it loads an environment carrying
`FAUCET_PRIVATE_KEY`, `HEARTH_FAUCET_PRIVATE_KEY` and `FAUCET_KEY_FILE` and asserts none of them
reaches the loaded config.

The brief's constraint is real: `SIGNABLE_PURPOSES` is `{deployer, treasury, deposit}`
(`custody/src/gates.ts:35`) and `deployer` maps to `creation` only, so custody cannot sign an
arbitrary contract call. **A faucet drip is not an arbitrary contract call.** It is a native EMBER
value transfer with empty calldata — precisely the `transfer` shape `treasury` maps to
(`custody/src/gates.ts:37-41`), whose policy `assertTransfer` (`custody/src/signing.ts:241-266`)
describes a drip exactly:

| `assertTransfer` requires | A drip |
|---|---|
| `to` a valid address, not the zero address | the recipient |
| `data` **empty**, refused otherwise | a drip carries no calldata |
| `value` positive, no ceiling | the drip amount |
| `gasLimit` in `[21_000, 200_000]` | 21,000, the intrinsic cost |
| exactly one fee model; `legacyOnly` refuses EIP-1559 | Ember v1 is type 0 only |
| `chainId` equal to the one custody resolved from the ROW | 7412, and never from us |

Every one of those is a rule this service would have had to enforce anyway, enforced instead by the
process that holds the key.

**The faucet gets its own treasury-purpose address and must not use the pinned one.** Custody's
pinned treasury for `(ember, testnet)` is settlement's; signing from it here would put two services
on one nonce, which is the exact bug `settlement/src/worker.ts` exists to fix. An operator mints the
faucet a dedicated address with `POST /v1/addresses` and its own `userId`/`orderId` — see
`.env.example`. `getTreasuryPin` is consulted only for `purpose: 'deposit'`
(`custody/src/keys.ts:307`), so the pin is not involved in signing this at all.

**The residual, said plainly.** A holder of this service's custody credential can send this address's
whole balance anywhere. That is what a `treasury` signer can do by construction — `SDR-05` says the
same of settlement — and the pin does not reduce it. What bounds it here is that the address is
funded to a faucet's float and nothing else, which is treasury-float policy rather than a signing
rule. It is strictly better than the alternative, where the same authority is a file on disk that
`ps`, a container inspect and a crash dump all expose.

There is **no admin-reveal route**. `micro-custody` deleted its own rather than guard it, and no
equivalent was added: `readDispense` does not even select `raw_tx`, `nonce` or `custody_audit_id`,
and `src/server.test.ts` asks every route for each of them and asserts on the returned bytes.

---

## The four things that make it safe

**1. The limits are rows, not a `Map`.** Each reservation is a single conditional upsert whose
`WHERE` clause *is* the limit, so there is no read to race against, and all three run inside one
transaction under a savepoint — a request that passes the cooldown and then fails the budget
consumes neither. `faucet_budget_within_cap` is the same ceiling stated by the schema, for the case
where some future write path forgets the clause.

**2. The lease names the chain.** `chain.dispense` is keyed `ember:testnet` — one row for every
replica in the estate to contend over — and `dispenses_in_flight_uniq` is the same statement made by
the database, for when the lease has already failed.

**3. The bytes are committed before they are broadcast.**

```
claim the row → read the nonce → ask custody → COMMIT THE BYTES → broadcast
```

A crash before the commit has broadcast nothing, so the signature is discarded unbroadcast and the
next tick starts from a fresh nonce. A crash after it leaves a `signed` row and the worker **resumes
at broadcast** with identical bytes — same nonce, same signature, same hash. The node either takes
it or says it already has it, and `AlreadyKnownError` reads the second as the success it is. There is
no path anywhere from `signed` back to `queued`.

**4. Testnet only, in code.** There is no chain-id variable with a default. The id is read from the
exact-pinned `@cloudsforge/contracts-chain`, the network is a `const`, and `FAUCET_CHAIN_ID` may only
agree or the process exits.

#### And what the estate does with that — decided 2026-08-05, in the estate and not here

The obvious complaint about point 4 is that a mainnet estate then has **no faucet at all**, and on
2026-08-05 that complaint had teeth: `network.cloudsforge.online/v1/faucet` answered **502** while
`/faucet` served a working page, because the estate's gateway routed `/v1` to a container that the
`ember-testnet` compose profile had never started. The estate was advertising a faucet that cannot
exist. Nothing failed on it; a person found it.

**The fix was made in the estate, and `NETWORK` was left alone.** The alternative was on the table —
make the network configurable and default mainnet's faucet to disabled — and it was refused. That
trades a compile-time impossibility for a default, and a default is a thing a deploy can override at
three in the morning. On the estate this runs on, mainnet EMBER is mined, publicly reachable and
backs the ledger: a faucet there is not a faucet, it is a giveaway. The whole point of `as const` is
that `NETWORK === 'mainnet'` is a *type error* and not a branch somebody can reach.

So `deploy/gateway/dynamic/estate-web.yml` now gates the `cf-api-network` router on
`CF_EMBER_NETWORK`, and a mainnet estate answers `404` — "there is no such service", which is true —
instead of `502`. `deploy/scripts/estate-verify.sh` fails if the two ever disagree again, in either
direction: a testnet with no faucet running, a faucet running on mainnet, or a route published for a
faucet that is not there.

One thing is still wrong and belongs to `micro-network-site`: the `/faucet` **page** is served on
the mainnet apex, so a visitor gets a drip form that renders disabled saying the faucet did not
answer — indistinguishable, to a reader, from the faucet being down. The honest page on a mainnet
estate says there is no mainnet faucet and links to the testnet one.

### The chain check, and why an absent node is *not* fatal

A node that **disagrees** is fatal. A node that **cannot be reached** is a warning and a soft
readiness probe, which is the frozen service's own asymmetry (`src/index.js:88-94`) and is right
here for a reason worth stating, because the opposite is the tempting call:

> An unreachable node cannot cause a wrong-chain signature, because **the chain id in a signature
> never comes from the node.** It comes from the pinned package, and custody resolves it a third
> time from the address's own row and refuses a mismatch (`custody/src/keys.ts:298-300`). Pointed at
> a mainnet node, this service would sign a 7412 transaction, that node would reject it under
> EIP-155, and nothing would move.

Refusing to boot would therefore buy no safety and cost real availability — the faucet could not
accept requests during a node restart, and accepting is the one thing it can still safely do.

---

## Tests

**157, zero skipped.** `pnpm test`, against a real Postgres.

No proof here needs a Hearth node. `indexer/src/hearth.test.ts:59` skips when none is reachable,
which is honest and also means those cases prove nothing on a machine without one. Every case here
runs against a real Postgres and two fakes — and the fake node does the one thing a real one will not
do on demand: **accept a transaction and lose the response.**

The races that are proved, not asserted:

* Two `JobRunner`s with different owners: exactly one claims `ember:testnet`, one signature.
* **With the lease removed entirely** — two workers driven straight at `driveChain` — the partial
  unique index is the last line and holds; four workers likewise; and two workers draining a
  four-request queue produce four signatures on four *distinct* nonces.
* A lost broadcast response: six recovery ticks later there is still one transaction in the mempool
  and custody was asked once.
* Ten concurrent requests for one address: one dispense, one drip of budget, and every loser gets a
  clean refusal rather than a 500. Ten concurrent *retries*: all ten answered with the same id.
* Twenty concurrent requests against a five-drip budget: exactly five, and the `CHECK` refuses an
  over-cap spend written directly with SQL.

Four bugs were found by these tests and fixed in the code rather than around them:

1. `reserve()` left a speculative grant row behind when a later limit refused — barring an address
   for a day over a rule it never broke. Fixed with a savepoint, so the guarantee no longer depends
   on what the caller does next.
2. `acceptDrip` returned 429 to a retry that arrived while the original was still committing, never
   serving the caller the dispense id it needed. The fingerprint is now re-read on the refusal path.
3. The recipient went to custody lower-cased rather than checksummed.
4. The "already known" pattern was written with spaces, so a node answering `ALREADY_EXISTS` had its
   re-broadcast read as a failure — on the exactly-once path.

One test claim was written, checked and found false before it was relied on: `Math.round(0.1 * 1e18)`
is exactly `1e17`, so the obvious float demonstration proves nothing. `src/env.test.ts` uses `1.1`
EMBER (off by 128 wei), a million EMBER (off by 16,777,216) and a full-precision amount instead.

---

## Running it

```sh
pnpm install
cp .env.example .env          # then fill in the CHANGE_ME values
pnpm migrate                  # a separate one-shot process, never the service
pnpm start
```

```sh
docker build -t micro-faucet \
  --build-context runtimepkgs=../runtime \
  --build-context contractspkgs=../contracts .
```

The migrator is a **separate one-shot process** — run it as an init container or a Job before the
service starts. Below `SCHEMA_VERSION` the two partial unique indexes and the budget `CHECK` may not
exist, and a service that could create them at boot is a service that could start without them.

### Routes

| | |
|---|---|
| `GET /livez` | Static. Consults nothing. |
| `GET /readyz` | Postgres **hard**, the Hearth node **soft**. |
| `GET /metrics` | Prometheus. Gated — it publishes the remaining budget. |
| `GET /v1/faucet` | The terms. Amounts are decimal strings, never JSON numbers. |
| `POST /v1/drips` | `{"address":"0x…"}` → **202** and a dispense id. Nothing is signed on this thread. |
| `GET /v1/drips/:id` | Poll it. |

Amounts cross the wire as decimal strings throughout: 1e19 wei is past what a double carries
exactly, and a client using `JSON.parse` on a number would silently receive a rounded amount.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
