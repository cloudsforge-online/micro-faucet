/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS SERVICE REFUSES TO START AGAINST ANY CHAIN THAT IS NOT THE EMBER TESTNET, AND THAT IS THE
 * MOST IMPORTANT LINE IN THE REPOSITORY.**
 *
 * A faucet is an unauthenticated withdrawal endpoint that happens to be pointed at a worthless
 * chain. Point it at a valuable one and nothing about it changes except the price of a request.
 *
 * The frozen service knows this — `stack/repos/hearth/tools/faucet/.env.example:22-24` says in so
 * many words that "a testnet faucet pointed at mainnet is an unauthenticated withdrawal endpoint" —
 * and then implements the wrong check. `src/index.js:71-75` compares the node's `eth_chainId`
 * against `env.chainId`, which is `num(process.env.HEARTH_CHAIN_ID, 7411)` (`src/env.js:94`). It
 * verifies AGREEMENT, not IDENTITY. Set `HEARTH_CHAIN_ID=7411`, point it at a mainnet node, and
 * every check passes — the two agree perfectly.
 *
 * And 7411 is not an arbitrary example. `@cloudsforge/contracts-chain` (`contracts/packages/chain/
 * src/index.ts:57`) records EMBER as `{ mainnet: 7411, testnet: 7412 }`. **7411 is the mainnet id,
 * and it is the frozen faucet's DEFAULT** — the value it takes when nobody sets the variable at
 * all. The local Hearth testnet node this was developed against answers `eth_chainId` with `0x1cf4`
 * = 7412, so the frozen faucet's out-of-the-box configuration does not even match the testnet.
 *
 * So there is no chain-id variable here. The chain id is READ from the pinned package, the network
 * is fixed to `testnet`, and `FAUCET_CHAIN_ID` — if anybody sets it out of habit — must equal that
 * value or the service exits. A number the deploy cannot choose is a number a deploy cannot get
 * wrong.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **THERE IS NO KEY VARIABLE HERE EITHER.** The frozen service reads a 32-byte secp256k1 scalar
 * from `HEARTH_FAUCET_PRIVATE_KEY` or a file (`src/env.js:41-83`) and holds it in memory for the
 * life of the process. This service holds no key material at all: it sends an unsigned transaction
 * to `micro-custody` and receives bytes. See `custodyclient.ts` for why the shapes allow that.
 *
 * Two behaviours are copied deliberately from the siblings:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic, and a placeholder that boots is a placeholder that reaches production.
 *
 * **THE ONE PIECE OF SECRET MATERIAL THIS PROCESS DOES HOLD IS `FAUCET_REQUESTER_SALT`**, and it
 * is not a credential — it is the pseudonymisation key for `faucet_requester_grants.requester`
 * (`requester.ts`, and `micro-org#163`). It is OPTIONAL and derived from `FAUCET_TOKEN` when
 * unset, which is a deliberate refusal to ship a constant default: a pseudonymisation key
 * committed to a repository is a pseudonymisation key that does not exist. A deployment that wants
 * the two rotated independently sets the variable; one that does not still gets a salt as strong
 * as the secret it already had to provide. Neither value is ever logged.
 *
 * **THAT DERIVATION IS ALSO WHY `FAUCET_TOKEN` BEING A PLACEHOLDER IS A PRIVACY DEFECT AND NOT
 * ONLY AN ACCESS ONE.** The estate runs `estate-only-faucet-operator-token-00000`, hardcoded on two
 * lines of a public compose file, and sets no `FAUCET_REQUESTER_SALT` — so every requester
 * pseudonym in `faucet_requester_grants` is derivable by anyone who can read the repository. The
 * guard below refuses that token, which is micro-org #142, and setting a real one is what makes the
 * pseudonymisation real for the first time.
 */

import { hostname } from 'node:os'
import { CHAINS, type Network } from '@cloudsforge/contracts-chain'
import { SecretError, assertGeneratedSecret, assertOpaqueSecret } from '@cloudsforge/secrets'
import { deriveRequesterSalt } from './requester.ts'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a migration
 * advisory lock.
 */
export const SERVICE = 'faucet'

/**
 * The one network this service will ever run against. Not configurable — see the file header.
 *
 * `as const` rather than a `Network` annotation so that `NETWORK === 'mainnet'` is a type error
 * rather than a branch: the impossibility is checked by the compiler and not only by a test.
 */
export const NETWORK = 'testnet' as const

/**
 * The EMBER testnet chain id, from the exact-pinned package and from nowhere else.
 *
 * `contracts/packages/chain/src/index.ts:57`. Not restated as a literal here: a second copy of a
 * chain id is a second thing to update, and the update that gets missed is the one that matters.
 */
export const CHAIN_ID: number = requireEmberChainId(NETWORK)

/** Confirmations before a dispense is called done — `contracts-chain`'s EMBER depth of 60. */
export const CONFIRMATIONS: number = CHAINS.EMBER.confirmations

function requireEmberChainId(network: Network): number {
  const id = CHAINS.EMBER.chainId?.[network]
  // Unreachable while `CHAINS.EMBER.chainId` is present, and checked anyway: the field is optional
  // on `ChainSpec` because Bitcoin has no chain id, so the type permits an EMBER without one. A
  // faucet that fell back to a default here would be the exact defect this file is about.
  if (typeof id !== 'number') {
    throw new EnvError(`@cloudsforge/contracts-chain publishes no EMBER chain id for ${network}`)
  }
  return id
}

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

/**
 * THE `PLACEHOLDERS` SET THAT USED TO BE HERE IS GONE, AND ITS ABSENCE IS THE FIX.
 *
 * It held nine exact strings and was paired with a 24-character floor. Neither could fail for the
 * value that is in `deploy/compose/docker-compose.estate.yml` on two lines TODAY:
 * `FAUCET_TOKEN: estate-only-faucet-operator-token-00000` is 39 characters and was on nobody's
 * list. Measured out of `cloudsforge-estate-faucet-1` on 2026-08-05, so this is not a reading of
 * the file — it is what the running container holds. Both lines are HARDCODED LITERALS rather than
 * `${FAUCET_TOKEN:-…}` interpolations, so no deploy has ever been able to override them.
 *
 * A check that cannot fail is worse than no check, because the absence of an alarm gets read as the
 * absence of a problem. Here it is worse than usual in one specific way: `FAUCET_TOKEN` is not only
 * the operator credential, it is ALSO the input `deriveRequesterSalt` pseudonymises requesters
 * with when `FAUCET_REQUESTER_SALT` is unset — which it is on both estates. A published token is
 * therefore a published pseudonymisation key, and every `faucet_requester_grants.requester` value
 * derived under it is recomputable by anyone who can read the compose file.
 *
 * A deny-list of exact strings is structurally unable to work: the next placeholder somebody writes
 * is, by definition, not on it. `@cloudsforge/secrets` asserts the SHAPE of the value instead,
 * which is the property a placeholder cannot have. It is imported rather than copied so that this
 * service cannot drift from the other sixteen.
 */

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

/**
 * Re-wrap the shared guard's `SecretError` as this service's `EnvError`.
 *
 * `loadEnv` documents a single error class for every configuration failure, and the boot path
 * catches that one class. The message is preserved verbatim — it already names the variable and the
 * command that fixes it, and it never contains the value.
 */
function asEnvError<T>(run: () => T): T {
  try {
    return run()
  } catch (err) {
    if (err instanceof SecretError) throw new EnvError(err.message)
    throw err
  }
}

/**
 * A secret whose ALPHABET THIS ESTATE DOES NOT CONTROL.
 *
 * ── WHY `assertOpaqueSecret` AND NOT `assertGeneratedSecret` ───────────────────────────────────
 *
 * `assertGeneratedSecret` is the stricter rule and it is the right one for a key the estate MINTS —
 * `FAUCET_REQUESTER_SALT` below is exactly that — because the estate chooses those values with
 * `openssl rand` and can therefore demand the base64 or hex alphabet of them.
 *
 * `FAUCET_TOKEN` is not minted by anything. Nothing in `deploy/scripts/estate-bootstrap.sh` issues
 * it; the compose file classes it with `ANALYTICS_TOKEN` as "a static shared secret … NOT minted by
 * identity", and `.env.example` tells an operator to type one in. It gates `/metrics` and the
 * operator read surface, so it is a value a person transcribes — the case `@cloudsforge/secrets`
 * documents `assertOpaqueSecret` for by name.
 *
 * ── IT REFUSES THE LIVE VALUE ANYWAY, WHICH IS THE ENTIRE POINT ────────────────────────────────
 *
 * The two rules differ on the alphabet and agree on everything that matters here. Both normalise
 * punctuation and case away and then refuse a placeholder MARKER anywhere in the value, so
 * `estate-only-faucet-operator-token-00000` flattens to a string containing `estateonly` and is
 * refused by either. The choice between them buys the operator a hand-set value that works; it does
 * not buy the defect a way through.
 *
 * **CONSEQUENCE, STATED PLAINLY: this service will not boot on the testnet estate until
 * `FAUCET_TOKEN` is set to a real value.** That is the fix, not a side effect of it — and because
 * the requester salt is derived from this value, setting it is also what makes the pseudonymisation
 * of `faucet_requester_grants` real for the first time.
 */
function requiredOpaqueSecret(source: Source, name: string): string {
  const value = required(source, name)
  asEnvError(() => assertOpaqueSecret(name, value))
  return value
}

/**
 * A GENERATED key the deployment MAY provide, held to the estate's own rule when it does.
 *
 * Absent is a supported answer and stays one — `FAUCET_REQUESTER_SALT` unset means DERIVED from
 * `FAUCET_TOKEN`, which is a deliberate refusal to ship a constant default, so the empty check sits
 * ahead of the assertion. Present-but-weak is not supported: accepting whatever is set because the
 * variable is optional is how a placeholder ends up being the thing that pseudonymises personal
 * data, and it would boot and pass every test.
 *
 * `assertGeneratedSecret` rather than `assertOpaqueSecret`, because this one IS a key the estate
 * generates and controls the format of. The derived fallback is `createHmac('sha256', …)
 * .digest('hex')` — 64 hex characters, 32 bytes — so the guard's own floor is exactly what the
 * derivation already produces, and an explicitly-set salt is now held to the standard its own
 * default meets. The old floor asked for 32 CHARACTERS, which a 32-character sentence clears while
 * carrying 24 bytes.
 */
function optionalGeneratedSecret(source: Source, name: string): string | undefined {
  const value = source[name]?.trim()
  if (!value) return undefined
  asEnvError(() => assertGeneratedSecret(name, value))
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

function url(source: Source, name: string, fallback?: string): string {
  const raw = fallback === undefined ? required(source, name) : optional(source, name, fallback)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new EnvError(`${name} must be an absolute URL (got ${raw})`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EnvError(`${name} must be http or https (got ${parsed.protocol})`)
  }
  return raw
}

/**
 * An EMBER amount in whole units, parsed to wei WITHOUT floating point.
 *
 * Carried across from `stack/repos/hearth/tools/faucet/src/env.js:19-25`, which got this right and
 * says why: EMBER has 18 decimals, so `Number('0.1') * 1e18` is 100000000000000000**0.0000000149**
 * and the drip is silently not the drip. The string is split on the point and the fraction is
 * right-padded, so every value this function returns is exact.
 *
 * Rule 4 of the brief — all amounts `bigint` — starts here, at the boundary where a decimal string
 * from a human becomes a number this service does arithmetic on.
 */
export function emberToWei(raw: string, name: string): bigint {
  const text = raw.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new EnvError(`${name} must be a non-negative decimal EMBER amount (got ${raw})`)
  }
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > DECIMALS) {
    throw new EnvError(`${name} has more than ${DECIMALS} decimal places (got ${raw})`)
  }
  return BigInt(`${whole}${fraction.padEnd(DECIMALS, '0')}`)
}

/** EMBER's smallest-unit exponent, from the pinned package. 18. */
export const DECIMALS: number = CHAINS.EMBER.decimals

/** One whole EMBER in wei. */
export const ONE_EMBER: bigint = 10n ** BigInt(DECIMALS)

function ember(source: Source, name: string, fallback: string): bigint {
  return emberToWei(optional(source, name, fallback), name)
}

export interface Limits {
  /**
   * The fixed payout, in wei. **Never read from a request**, at any point, by any route.
   *
   * The frozen service says why at `src/server.js:187-188` and it is the one design decision worth
   * copying without change: "every faucet that has ever been drained let the caller influence the
   * amount".
   */
  readonly dripWei: bigint
  /** One drip per address per this many seconds. The only limit an honest user ever meets. */
  readonly addressCooldownSeconds: number
  /** Drips per requester per window. A requester is an identity or an address — see `limits.ts`. */
  readonly requesterLimit: number
  readonly requesterWindowSeconds: number
  /**
   * THE CONTROL THAT BOUNDS THE LOSS. However many addresses and however many requesters, the
   * faucet pays out at most this per rolling window and then refuses everyone.
   */
  readonly budgetWei: bigint
  readonly budgetWindowSeconds: number
  /** Refuse an address that already holds this much. A faucet exists to unblock someone with none. */
  readonly maxRecipientBalanceWei: bigint
  /** Stop cleanly at this balance rather than broadcasting transactions the node will reject. */
  readonly reserveWei: bigint
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  readonly instanceId: string

  /** The credential Prometheus presents in `x-faucet-token`, and the operator read surface. */
  readonly token: string

  /** The Hearth testnet `eth_*` endpoint. */
  readonly rpcUrl: string
  readonly rpcDeadlineMs: number

  /** Where `micro-custody` lives, and the address it signs for. See `custodyclient.ts`. */
  readonly custodyUrl: string
  readonly custodyDeadlineMs: number
  readonly custodyToken: string
  /** The faucet's own funding address. Custody holds the key; this process never sees it. */
  readonly fundingAddress: string
  /**
   * The `orderId` half of custody's binding for that address. Custody compares seven identity
   * fields character for character and its 403 deliberately does not say which one disagreed
   * (`custody/src/keys.ts:277-283`), so this cannot be debugged from a response and has to be
   * right by construction. It is a variable rather than a derivation because the address is minted
   * by an operator with `POST /v1/addresses`, who chooses it.
   */
  readonly custodyOrderId: string
  readonly custodyUserId: string

  /** Legacy (type 0) gas price in wei. Ember v1 has no EIP-1559 fee market. */
  readonly gasPriceWei: bigint

  readonly limits: Limits

  /** How the per-requester counter is keyed without storing an address. See `requester.ts`. */
  readonly requester: RequesterPrivacy

  /** Dispense rows kept after they reach a terminal state. Operator forensics, then pruned. */
  readonly retentionDays: number
}

export interface RequesterPrivacy {
  /**
   * The pseudonymisation secret for `faucet_requester_grants.requester`. **Never logged, never
   * returned, never written to the database** — it is the whole reason a stored key cannot be
   * turned back into a network, and a key held beside the data it protects protects nothing.
   */
  readonly salt: string
  /**
   * Seconds a requester row may exist, AND the salt's rotation period, because they are one event:
   * when the salt rotates every key derived under the old one is unreachable, so deleting those
   * rows IS the retention enforcement rather than a second policy that could disagree with it.
   *
   * Bounded to a small multiple of `requesterWindowSeconds` by the check in `loadEnv`. Nothing
   * needs a row older than the window it bounds, which is why this is NOT `FAUCET_RETENTION_DAYS`:
   * thirty days of dispense forensics is a defensible period for a payout ledger and an
   * indefensible one for a rate-limiter's counter.
   */
  readonly retentionSeconds: number
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  /* ── The testnet gate. See the file header; this is the whole of it. ────────────────────── */
  const declared = source['FAUCET_CHAIN_ID']?.trim()
  if (declared !== undefined && declared.length > 0 && Number(declared) !== CHAIN_ID) {
    const mainnet = CHAINS.EMBER.chainId?.mainnet
    throw new EnvError(
      `FAUCET_CHAIN_ID is ${declared}; this service dispenses on the EMBER ${NETWORK} only, ` +
        `which @cloudsforge/contracts-chain pins at ${CHAIN_ID}. ` +
        (Number(declared) === mainnet
          ? `${declared} is EMBER MAINNET. A faucet is an unauthenticated withdrawal endpoint; ` +
            'the only thing making that acceptable is that the coin is worthless. It is not ' +
            'configurable and there is no flag that makes it configurable.'
          : 'Unset the variable — the chain id is read from the pinned package, not chosen.'),
    )
  }

  const dripWei = ember(source, 'FAUCET_DRIP_EMBER', '10')
  if (dripWei <= 0n) throw new EnvError('FAUCET_DRIP_EMBER must be greater than zero')

  const budgetWei = ember(source, 'FAUCET_BUDGET_EMBER', '1000')
  if (budgetWei < dripWei) {
    // A budget below one drip is a faucet that refuses everybody while reporting a healthy
    // balance, which costs an operator an afternoon before anyone reads the number.
    throw new EnvError(
      `FAUCET_BUDGET_EMBER (${budgetWei} wei) is below FAUCET_DRIP_EMBER (${dripWei} wei) — ` +
        'the faucet could never serve a single request',
    )
  }

  const maxRecipientBalanceWei = ember(source, 'FAUCET_MAX_RECIPIENT_EMBER', '100')
  if (maxRecipientBalanceWei > 0n && maxRecipientBalanceWei < dripWei) {
    // The ceiling is checked BEFORE the drip lands, so a ceiling under one drip means every
    // recipient of a first drip is permanently barred from a second by a rule about being
    // "already funded". Refused here rather than discovered in a support thread.
    throw new EnvError(
      `FAUCET_MAX_RECIPIENT_EMBER (${maxRecipientBalanceWei} wei) is below one drip ` +
        `(${dripWei} wei) — every address funded once would then be permanently over the ceiling`,
    )
  }

  const requesterWindowSeconds = integer(source, 'FAUCET_REQUESTER_WINDOW_SECONDS', 86_400, 1, 31_536_000)

  /* ── The requester's privacy budget. See `requester.ts` for the whole argument. ─────────── */
  const token = requiredOpaqueSecret(source, 'FAUCET_TOKEN')
  const requesterSalt = optionalGeneratedSecret(source, 'FAUCET_REQUESTER_SALT') ?? deriveRequesterSalt(token)
  // Two days by default — two windows, not thirty. The floor is the window itself and the ceiling
  // is thirty days, which is only reachable by an operator who has also widened the window.
  const requesterRetentionSeconds = integer(
    source,
    'FAUCET_REQUESTER_RETENTION_SECONDS',
    172_800,
    60,
    2_592_000,
  )
  if (requesterRetentionSeconds < requesterWindowSeconds) {
    // Refused rather than clamped. A retention period shorter than the window it is supposed to
    // outlive deletes rows that are still counting, which hands every requester an unlimited
    // supply of drips — a privacy setting that silently disables a rate limit, discovered by
    // reading a budget that has gone.
    throw new EnvError(
      `FAUCET_REQUESTER_RETENTION_SECONDS (${requesterRetentionSeconds}) is below ` +
        `FAUCET_REQUESTER_WINDOW_SECONDS (${requesterWindowSeconds}) — the prune would delete ` +
        'counters that are still inside the window they bound, and the per-requester limit would ' +
        'stop refusing anybody',
    )
  }

  return {
    port: integer(source, 'PORT', 4013, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'FAUCET_DATABASE_URL'),
    databasePoolMax: integer(source, 'FAUCET_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    token,

    rpcUrl: url(source, 'FAUCET_RPC_URL'),
    rpcDeadlineMs: integer(source, 'FAUCET_RPC_DEADLINE_MS', 10_000, 100, 120_000),

    custodyUrl: url(source, 'CUSTODY_URL'),
    custodyDeadlineMs: integer(source, 'CUSTODY_DEADLINE_MS', 10_000, 100, 120_000),
    /**
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     * **THIS ONE IS DELIBERATELY UNGUARDED, AND THAT IS A DEFECT LEFT OPEN ON PURPOSE — #142/#222.**
     *
     * Every other secret this file reads goes through `@cloudsforge/secrets`. This one does not,
     * and the reason is measured rather than reasoned: `cloudsforge-estate-faucet-1` holds a
     * 669-CHARACTER JWT in `CUSTODY_TOKEN` (2026-08-05). Both `assertOpaqueSecret` and
     * `assertServiceCredential` refuse a JWT BY NAME — correctly, because a minted token expires
     * and this variable is read once at boot — so guarding this variable would crash-loop the
     * faucet on the estate the day this ships.
     *
     * It is a JWT because the deploy intends one. `index.ts:137` is `token: () => env.custodyToken`
     * handed straight to `HttpClient`, which sets `authorization: Bearer <that value>` verbatim;
     * there is no `ServiceTokenProvider` in this repository, so custody's gate requires an identity
     * TOKEN and a `cfsc_…` credential here would 401 every signature request. The compose file
     * records the same finding at length and calls the ten-minute cliff here "REAL … and worse than
     * emberkin's", because the call site is the job queue rather than a request path.
     *
     * So there are two defects stacked on one variable and they cannot be fixed in this order:
     *
     *   1. The compose default is `${FAUCET_CUSTODY_TOKEN:-estate-placeholder-token-0000000000000000}`,
     *      which is micro-org #142 exactly, and nothing here refuses it.
     *   2. The value the bootstrap actually writes is a ten-minute token, which is micro-org #222,
     *      and it is what makes (1) unfixable from this file.
     *
     * Fixing (2) first is the honest order: adopt `ServiceTokenProvider` and read
     * `FAUCET_IDENTITY_CREDENTIAL`, which `estate-bootstrap.sh` §5b already mints and which is
     * already sitting in `tokens.env`. On the day that lands, this line becomes
     * `assertServiceCredential` and (1) closes with it. Until then a guard here would refuse the
     * only value that works, and a guard that refuses correct input is a guard somebody deletes.
     *
     * What it costs meanwhile is bounded and visible rather than silent: the dispense stays
     * `queued`, the row is retried, and it completes after the next bootstrap.
     * ═══════════════════════════════════════════════════════════════════════════════════════════
     */
    custodyToken: required(source, 'CUSTODY_TOKEN'),
    fundingAddress: address(source, 'FAUCET_FUNDING_ADDRESS'),
    custodyOrderId: required(source, 'FAUCET_CUSTODY_ORDER_ID'),
    custodyUserId: required(source, 'FAUCET_CUSTODY_USER_ID'),

    gasPriceWei: BigInt(integer(source, 'FAUCET_GAS_PRICE_WEI', 1_000_000_000, 1, Number.MAX_SAFE_INTEGER)),

    limits: {
      dripWei,
      addressCooldownSeconds: integer(source, 'FAUCET_ADDRESS_COOLDOWN_SECONDS', 86_400, 1, 31_536_000),
      requesterLimit: integer(source, 'FAUCET_REQUESTER_LIMIT', 3, 1, 10_000),
      requesterWindowSeconds,
      budgetWei,
      budgetWindowSeconds: integer(source, 'FAUCET_BUDGET_WINDOW_SECONDS', 86_400, 1, 31_536_000),
      maxRecipientBalanceWei,
      reserveWei: ember(source, 'FAUCET_RESERVE_EMBER', '1'),
    },

    requester: {
      salt: requesterSalt,
      retentionSeconds: requesterRetentionSeconds,
    },

    retentionDays: integer(source, 'FAUCET_RETENTION_DAYS', 30, 1, 3_650),
  }
}

/** A configured address is validated at boot, not at the first dispense. */
function address(source: Source, name: string): string {
  const value = required(source, name)
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new EnvError(`${name} must be 0x followed by 40 hex characters (got ${value})`)
  }
  return value
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed through
 * the telemetry package: nothing that can itself fail may sit between a configuration error and
 * the report of it.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
