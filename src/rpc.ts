/**
 * The Hearth `eth_*` endpoint, in the six calls this service makes.
 *
 * Ported from `stack/repos/hearth/tools/faucet/src/rpc.js`, which is a good forty lines and gets
 * two things right that are worth carrying: strict hex QUANTITY handling in both directions, and —
 * the part that is genuinely earned experience — the two error messages that name Hearth's
 * UTXO-era REST API. That server lives on a neighbouring port, answers any POST it does not
 * recognise with `{"err":"no route"}` at HTTP 200, and is by a distance the most common
 * misconfiguration. Without those checks the symptom is "cannot convert undefined to BigInt" four
 * frames away from the cause. Both are kept, and both were confirmed against the running node: a
 * POST to 127.0.0.1:8647 answers `{"err":"this is the REST API — the Ethereum JSON-RPC endpoint is
 * a different port"}`, while 8547 answers `{"jsonrpc":"2.0","id":1,"result":"0x1cf4"}` — 7412.
 *
 * What changed in the port:
 *
 *   * `node:http` hand-rolled request handling became `fetch` under an `AbortSignal`. The frozen
 *     version's `req.on('timeout')` fires on socket inactivity rather than on elapsed time, so a
 *     node dribbling one byte a second holds a faucet request open indefinitely.
 *   * **EVERY QUANTITY IS A `bigint`.** `chainId` and `nonce` are the two that must become numbers
 *     — custody's `signEvm` refuses a non-safe-integer rather than rounding it
 *     (`custody/src/signing.ts:74`) — and both are range-checked at the boundary here rather than
 *     coerced at the call site. The frozen `chainId()` does a bare `Number(toBig(…))`
 *     (`rpc.js:99`), which is fine for a chain id and would not be fine for anything else.
 *   * `eth_sendRawTransaction` distinguishes "the node already has this" from every other failure.
 *     That distinction does not exist in the frozen client and it is what makes the retry path in
 *     `dispense.ts` safe — see `AlreadyKnownError`.
 */

const HEX_QUANTITY = /^0x([0-9a-fA-F]+)$/

/** The node answered, and what it said was an error. Never retried with the same request. */
export class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'RpcError'
    this.code = code
  }
}

/** The node could not be reached, or did not answer JSON-RPC. We do not know what it did. */
export class RpcUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcUnavailableError'
  }
}

/**
 * The node already holds this exact transaction.
 *
 * **This is a SUCCESS, and treating it as one is the whole of exactly-once dispensing.** A
 * re-broadcast of identical bytes is not a second transaction: it has the same nonce, the same
 * signature and therefore the same hash. A node answers the second one with an error rather than
 * with the hash — "already known", "known transaction", "ALREADY_EXISTS", the wording differs by
 * client — and a service that read that as a failure would either give up on a payment that is
 * already on chain or, far worse, sign a replacement with a fresh nonce.
 *
 * "nonce too low" is folded in here for the same reason with a stronger justification: it means
 * the chain has already moved past this nonce, which for bytes we hold and have already committed
 * means this transaction, or one from this address at this nonce, is mined. Either way there is
 * nothing left to broadcast and the right next step is to go and look for the receipt.
 */
export class AlreadyKnownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AlreadyKnownError'
  }
}

const ALREADY_KNOWN = /already known|known transaction|already exists|nonce too low|replacement transaction underpriced/i

export interface TransactionReceipt {
  readonly blockNumber: bigint
  /** `0x1` success, `0x0` reverted. A reverted plain transfer is a chain fault, not a user error. */
  readonly status: boolean
}

export interface RpcOptions {
  readonly url: string
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

export class Rpc {
  readonly #url: string
  readonly #deadlineMs: number
  readonly #fetch: typeof globalThis.fetch
  #nextId = 1

  constructor(options: RpcOptions) {
    this.#url = options.url
    this.#deadlineMs = options.deadlineMs
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async call(method: string, params: readonly unknown[] = []): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params })
    // A wall-clock deadline, not a socket-inactivity timeout: a node answering one byte per second
    // is a node this service must give up on, and `req.on('timeout')` never fires for it.
    const signal = AbortSignal.timeout(this.#deadlineMs)

    let response: Response
    try {
      response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      })
    } catch (err) {
      throw new RpcUnavailableError(
        `${redact(this.#url)} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new RpcUnavailableError(
        `${redact(this.#url)} did not return JSON (HTTP ${response.status}): ${text.slice(0, 120)}`,
      )
    }
    const envelope = payload as { result?: unknown; error?: { code?: unknown; message?: unknown } }

    if (envelope.error) {
      const message = typeof envelope.error.message === 'string' ? envelope.error.message : 'rpc error'
      const code = typeof envelope.error.code === 'number' ? envelope.error.code : -32_000
      throw new RpcError(code, message)
    }
    if (!('result' in envelope)) {
      // Carried from the frozen client (`rpc.js:74-88`), whose diagnosis is exactly right and was
      // reconfirmed against the running node: Hearth's UTXO-era REST API answers an unknown POST
      // with `{"err":…}` at HTTP 200, which parses as JSON and would otherwise surface four frames
      // later as "cannot convert undefined to BigInt".
      throw new RpcUnavailableError(
        `${redact(this.#url)} answered without a JSON-RPC result (${text.slice(0, 120)}). ` +
          'If that looks like {"err":…}, this is the UTXO-era REST API, not the eth_* endpoint.',
      )
    }
    return envelope.result
  }

  /** The chain id the NODE reports. Compared against the pinned one before anything is signed. */
  async chainId(): Promise<number> {
    return smallInteger(await this.call('eth_chainId'), 'eth_chainId')
  }

  async blockNumber(): Promise<bigint> {
    return quantity(await this.call('eth_blockNumber'), 'eth_blockNumber')
  }

  async getBalance(address: string, at: 'latest' | 'pending' = 'latest'): Promise<bigint> {
    return quantity(await this.call('eth_getBalance', [address, at]), 'eth_getBalance')
  }

  /**
   * The nonce, at **pending**.
   *
   * `latest` ignores anything this address already has in the mempool, which produces a second
   * transaction with the same nonce — at most one of which can ever be mined. The chain lease in
   * `jobs.ts` means this should not arise; `pending` is the belt to that braces, and
   * `dispenses_in_flight_uniq` is the third.
   */
  async getNonce(address: string, at: 'pending' | 'latest' = 'pending'): Promise<number> {
    return smallInteger(await this.call('eth_getTransactionCount', [address, at]), 'eth_getTransactionCount')
  }

  /**
   * Broadcast. Answers the hash, or throws `AlreadyKnownError` when the node already has it.
   *
   * The hash is NOT read from the response and returned to the caller — `dispense.ts` derives it
   * from the bytes with `keccak256` before this is ever called, and compares. A hash this service
   * did not compute is a hash it cannot re-derive on the recovery path, which is exactly the path
   * that needs it.
   */
  async sendRawTransaction(rawTx: string): Promise<string> {
    try {
      const result = await this.call('eth_sendRawTransaction', [rawTx])
      if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
        throw new RpcUnavailableError(`eth_sendRawTransaction returned ${String(result)}, not a transaction hash`)
      }
      return result.toLowerCase()
    } catch (err) {
      if (err instanceof RpcError && ALREADY_KNOWN.test(err.message)) {
        throw new AlreadyKnownError(err.message)
      }
      throw err
    }
  }

  /** Null while the transaction is still in the mempool. Null is an ANSWER, not a fault. */
  async getTransactionReceipt(hash: string): Promise<TransactionReceipt | null> {
    const result = await this.call('eth_getTransactionReceipt', [hash])
    if (result === null || result === undefined) return null
    const row = result as { blockNumber?: unknown; status?: unknown }
    if (typeof row.blockNumber !== 'string') return null
    return {
      blockNumber: quantity(row.blockNumber, 'receipt.blockNumber'),
      // A receipt with no status is pre-Byzantium and cannot happen on Hearth, whose EVM is
      // post-Byzantium by construction. Absent is read as success rather than as failure, which is
      // the direction that does not mark a mined payment as lost.
      status: row.status === undefined || quantity(row.status, 'receipt.status') === 1n,
    }
  }
}

/**
 * Hex QUANTITY → `bigint`, refusing anything that is not one rather than reading it as zero.
 *
 * `BigInt('0x')` throws but `Number('0x')` is NaN and `parseInt` of a malformed quantity is a
 * partial parse; a balance silently read as zero is a faucet that reports itself dry.
 */
export function quantity(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !HEX_QUANTITY.test(value)) {
    throw new RpcUnavailableError(`${what} answered ${JSON.stringify(value)}, which is not a hex quantity`)
  }
  return BigInt(value)
}

/**
 * A quantity that must fit in a JS integer: a chain id or a nonce, and nothing else.
 *
 * Range-checked rather than coerced. Custody refuses a non-safe-integer nonce rather than rounding
 * it (`custody/src/signing.ts:74`), so a nonce past 2^53 must fail HERE, loudly, rather than
 * arriving there as a rounded number that signs a transaction nobody asked for.
 */
export function smallInteger(value: unknown, what: string): number {
  const big = quantity(value, what)
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RpcUnavailableError(`${what} answered ${big}, which is past the safe integer range`)
  }
  return Number(big)
}

/** A node URL may carry a key in its path — an Infura-shaped endpoint does. Never log the path. */
function redact(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}`
  } catch {
    return 'the configured RPC URL'
  }
}
