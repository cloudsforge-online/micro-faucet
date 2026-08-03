/**
 * Custody, and where the faucet's key lives.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS SERVICE HOLDS NO KEY AND ASKS FOR NONE.** It sends an unsigned transaction and receives
 * bytes. There is no field on any type in this file that could carry key material, no route on the
 * service that returns one, and no configuration variable that accepts one.
 *
 * ## Why custody rather than a local key, and how the shapes allow it
 *
 * The brief's constraint is real: `SIGNABLE_PURPOSES` is `{deployer, treasury, deposit}`
 * (`custody/src/gates.ts:35`) and `deployer` maps to `creation` only, so custody cannot sign an
 * arbitrary contract call. A faucet drip is not an arbitrary contract call. It is a **native EMBER
 * value transfer with empty calldata**, which is precisely the `transfer` shape that `treasury`
 * maps to (`custody/src/gates.ts:37-41`), and `assertTransfer` (`custody/src/signing.ts:241-266`)
 * describes a drip exactly:
 *
 *   * `to` a valid address, and not the zero address                — the recipient
 *   * `data` EMPTY, refused otherwise                               — a drip carries no calldata
 *   * `value` positive, no ceiling                                  — the drip amount
 *   * `gasLimit` in [21,000, 200,000]                               — 21,000, the intrinsic cost
 *   * exactly one fee model, and `legacyOnly` refuses EIP-1559      — Ember v1 is type 0 only
 *   * `chainId` equal to the one custody resolved from the ROW      — 7412, and never from us
 *
 * Every one of those is a rule this service was going to have to enforce anyway, enforced instead
 * by the process that holds the key. That is the argument for custody and it is decisive: the
 * alternative is a 32-byte scalar in this container's environment, which is what the frozen service
 * does (`stack/repos/hearth/tools/faucet/src/env.js:41-83`) and which is why that file is three
 * quarters comments about how keys leak.
 *
 * ## The faucet gets its OWN treasury-purpose address, and must not use the pinned one
 *
 * Custody's PINNED treasury for `(ember, testnet)` is settlement's. Signing from it here would put
 * two services on one nonce, and `settlement/src/worker.ts:8-18` exists because that is how a
 * payment gets permanently lost. So an operator mints the faucet a dedicated address with
 * `POST /v1/addresses` — `purpose: 'treasury'`, `chain: 'ember'`, `network: 'testnet'`, and a
 * `userId`/`orderId` of the faucet's own — and configures it. It is a treasury-purpose address that
 * is not THE treasury: `getTreasuryPin` is consulted only for `purpose: 'deposit'`
 * (`custody/src/keys.ts:307`), so the pin is not involved in signing this at all.
 *
 * The residual, said plainly, because SDR-05 says the equivalent about settlement: a holder of this
 * service's custody credential can send this address's whole balance anywhere. That is the exposure
 * a `treasury` signer has by construction and the pin does not reduce it. What bounds it here is
 * that the address is funded to a faucet's float and nothing else, which is a treasury-float policy
 * rather than a signing rule — and it is strictly better than the frozen alternative, where the
 * same authority is a file on disk that `ps`, a container inspect and a crash dump all expose.
 *
 * ## The binding is restated, and cannot be debugged from the response
 *
 * `POST /v1/sign` compares seven identity fields character for character and its 403 deliberately
 * does NOT name the one that disagreed, because that would be an oracle a caller could walk one
 * field at a time (`custody/src/keys.ts:277-283`). So the binding here is configuration that has to
 * be right by construction, and `env.ts` carries `FAUCET_CUSTODY_ORDER_ID` and
 * `FAUCET_CUSTODY_USER_ID` for exactly that reason rather than deriving something custody would
 * refuse.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scope this service's custody token must carry. Named here so the deploy can be derived.
 *
 * `custody:sign:treasury` and nothing else. Not `custody:sign:deposit`, which sweeps INTO the
 * treasury and which this service has no use for — settlement's own client notes that "a deployment
 * that does not sweep should not be issued the second" (`settlement/src/custodyclient.ts:48-52`),
 * and this one does not sweep. Not `custody:treasury:read`: the pin is irrelevant to a
 * treasury-purpose signature and asking for the authority to read it would be asking for authority
 * with no call site.
 *
 * ── THE ANNOTATION: AN OUTBOUND DEMAND, TYPED AGAINST THE REGISTRY ───────────────────────────
 *
 * `readonly LiveScope[]`, not `readonly string[]`. `service-ci.yml` proves that every scope a
 * repository's route GATES demand is registered — the INBOUND direction. This constant is the
 * other one: what this service PRESENTS to a peer. Nothing had ever checked it, which is how
 * `micro-market` declared `policy:evaluate` and `micro-wallet` `custody:address` — neither ever
 * a registry key — for the life of both services. `derive-grants.mjs` reads this into
 * `IDENTITY_SERVICE_TOKEN_GRANTS`, and identity validates that list at import and REFUSES TO
 * START on an unknown name (`identity/src/env.ts:141`): a dead identity container, so no tokens
 * for anybody.
 *
 * `LiveScope` rather than `Scope` because `Scope` is `keyof typeof SCOPES` — every registered
 * key, DEPRECATED ones included — and identity will not mint a deprecated scope either.
 * `LiveScope = Exclude<Scope, DeprecatedScope>`, with `DeprecatedScope` computed FROM `SCOPES` by
 * a conditional type over the `deprecated` field rather than hand-listed
 * (`contracts/packages/auth/src/index.ts:507`), so it cannot drift from the registry. `Scope`
 * keeps its wide meaning and this does not narrow it: a token arriving from anywhere may carry a
 * scope that has since died, so reading is wide and demanding is narrow. This is demanding.
 */
export const CUSTODY_SCOPES: readonly LiveScope[] = Object.freeze(['custody:sign:treasury'])

/** Custody looked at the request and refused it. Never retriable with the same request. */
export class CustodySignRefusedError extends Error {
  /** `purpose_forbidden · binding_mismatch · shape_refused · not_found`. */
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'CustodySignRefusedError'
    this.code = code
    this.status = status
  }
}

/** Custody could not be reached, or answered 5xx. **We do not know whether it signed.** */
export class CustodyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustodyUnavailableError'
  }
}

/**
 * The unsigned legacy transaction, in the shape `signEvm` accepts and no other.
 *
 * `value` and `gasPrice` are DECIMAL STRINGS rather than numbers. One EMBER is 1e18 wei, four
 * orders of magnitude past what a double holds exactly, and custody's `quantity` refuses a
 * non-safe-integer number rather than rounding it (`custody/src/signing.ts:74`) — which is the
 * fail-closed half of this. Sending a `bigint` is not an option either: `JSON.stringify` throws on
 * one, so the conversion has to be deliberate and it happens here, once.
 *
 * `type: 0` is stated rather than left off. Custody infers legacy from the presence of `gasPrice`
 * and would accept the omission, but Ember v1 has no type-2 decoder — a 1559 transaction signed for
 * it is not something the network rejects, it is bytes nothing on that chain can parse
 * (`custody/src/signing.ts:146-150`) — so the one place this service can say so, it says so.
 */
export interface UnsignedDrip {
  readonly to: string
  readonly value: string
  readonly gasLimit: number
  readonly gasPrice: string
  readonly nonce: number
  readonly chainId: number
  readonly type: 0
  readonly data: '0x'
}

export interface SignedResult {
  /** The serialised signed transaction. This is what gets COMMITTED, and only then broadcast. */
  readonly signedTx: string
  /** The id of the audit row custody committed with the signature. Stored beside the bytes. */
  readonly auditId: string
}

export interface CustodyBinding {
  readonly address: string
  readonly userId: string
  readonly orderId: string
}

export interface CustodyClient {
  sign(input: { readonly payload: UnsignedDrip; readonly correlationId: string }): Promise<SignedResult>
}

export interface CustodyClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly binding: CustodyBinding
  readonly fetch?: typeof globalThis.fetch
}

export function httpCustodyClient(options: CustodyClientOptions): CustodyClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'custody',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async sign(input) {
      try {
        // NO IDEMPOTENCY KEY, and its absence is deliberate — settlement makes the same call for
        // the same reason (`settlement/src/custodyclient.ts:150-155`). `HttpClient` attempts a POST
        // exactly once unless a key is present, which is what is wanted: this service must never be
        // in a position where two sets of bytes exist for one dispense. A signature that was made
        // and whose RESPONSE was lost is discarded UNBROADCAST — nothing was sent, so nothing
        // moved — and the next tick builds again from a fresh nonce read.
        const body = await client.request<SignedResult>('/v1/sign', {
          method: 'POST',
          body: {
            address: options.binding.address,
            // Custody's chain NAME. Its names are ethereum/bitcoin/solana/xrp/**ember**, and for
            // this chain the name and this service's slug agree, so there is no translation to get
            // wrong — unlike `eth` versus `ethereum`, which settlement has to map.
            chain: 'ember',
            network: 'testnet',
            family: 'ember',
            // The purpose SELECTS THE POLICY, it does not label the address. `treasury` signs plain
            // value transfers and cannot sign a creation; a mislabelled address is a 403 rather
            // than a wider signature.
            purpose: 'treasury',
            userId: options.binding.userId,
            orderId: options.binding.orderId,
            payload: input.payload,
          },
          requestId: input.correlationId,
        })
        if (typeof body.signedTx !== 'string' || body.signedTx.length === 0) {
          throw new CustodyUnavailableError('custody answered 200 with no signature')
        }
        return { signedTx: body.signedTx, auditId: typeof body.auditId === 'string' ? body.auditId : '' }
      } catch (err) {
        throw translateSign(err)
      }
    },
  }
}

/**
 * Turn an HTTP failure into one of the two things a caller can act on.
 *
 * `HttpError.peerDecided` is the discriminator: a 4xx means custody looked at the request and said
 * no, which is a permanent fact about this request and must not be retried. Anything else — a 5xx,
 * a timeout, an open circuit — means we do not know whether it signed, and the only safe response
 * is to leave the row where it is and try again on the next tick from a fresh nonce.
 *
 * The distinction matters here for the same reason it does in settlement: a "refusal" that was
 * really a timeout would release the reservation and mark the dispense failed while a signature
 * that could still reach a node may exist. Nothing was broadcast in either case — which is why the
 * commit is placed where it is — but the two states are not the same and must not be collapsed.
 */
function translateSign(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body)
    return new CustodySignRefusedError(err.status, parsed.code, parsed.message)
  }
  if (err instanceof CustodyUnavailableError || err instanceof CustodySignRefusedError) return err
  return new CustodyUnavailableError(err instanceof Error ? err.message : String(err))
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
    return {
      code: typeof error?.code === 'string' ? error.code : 'custody_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    }
  } catch {
    return { code: 'custody_error', message: body.slice(0, 500) }
  }
}
