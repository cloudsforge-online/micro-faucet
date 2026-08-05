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
 */

import { hostname } from 'node:os'
import { CHAINS, type Network } from '@cloudsforge/contracts-chain'
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

const PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'change_me',
  'placeholder',
  'secret',
  'token',
  'dev-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name)
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  // Length is a proxy for entropy and the only one available here. It is set above the point at
  // which a human-chosen string is plausible, so a memorable password fails this check too.
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
}

/**
 * A secret the deployment MAY provide, held to the same bar as one it must.
 *
 * Absent is a supported answer; present-but-weak is not. The alternative — accepting whatever is
 * set because the variable is optional — is how a placeholder ends up being the thing that
 * pseudonymises personal data, and it would boot and pass every test.
 */
function optionalSecret(source: Source, name: string, minLength: number): string | undefined {
  const value = source[name]?.trim()
  if (!value) return undefined
  return requiredSecret(source, name, minLength)
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
  const token = requiredSecret(source, 'FAUCET_TOKEN')
  const requesterSalt = optionalSecret(source, 'FAUCET_REQUESTER_SALT', 32) ?? deriveRequesterSalt(token)
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
    custodyToken: requiredSecret(source, 'CUSTODY_TOKEN'),
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
