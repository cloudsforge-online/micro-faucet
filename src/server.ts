/**
 * The HTTP surface.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THERE IS NO ROUTE HERE THAT RETURNS KEY MATERIAL, AND THERE IS NOTHING FOR ONE TO RETURN.**
 *
 * `micro-custody` deleted its admin-reveal endpoint rather than guard it, and rule 6 of the brief
 * says to add no equivalent. This service is in the strongest possible position to comply: the key
 * is custody's, this process never holds one, and `env.ts` has no variable that accepts one. The
 * three things that would be worth stealing from this service are the custody token, the funding
 * address's raw signed transactions, and the `x-faucet-token`. None appears in any response body:
 * `readDispense` does not select `raw_tx`, `nonce` or `custody_audit_id` (`requests.ts`), and the
 * error mapper below emits a fixed message per code rather than the caught error's own text.
 *
 * **`/livez` IS STATIC AND `/readyz` IS REAL, AND THE HARD/SOFT SPLIT IS DELIBERATE.**
 *
 *   hard  postgres  — every limit, every dispense and every grant is a row. Without it this
 *                     service cannot refuse a request safely, and a faucet that cannot refuse is
 *                     worse than a faucet that is down. It must not receive traffic.
 *   soft  the node  — a Hearth testnet node restarting is ordinary. The queue keeps accepting,
 *                     `driveChain` holds rather than fails, and the drips land when it comes back.
 *                     Failing readiness here would take the service out of the balancer for a
 *                     condition it recovers from by itself.
 *   soft  custody   — same argument, and one more: custody being unreachable means signatures
 *                     stop, not that acceptance is unsafe. A dispense that cannot be signed waits
 *                     in `queued`, which is exactly where an unsignable dispense belongs.
 *
 * The frozen service has one route for all three (`GET /health`, `server.js:130-151`) and answers
 * 503 when the faucet is dry — so an empty faucet is pulled out of the balancer and the page that
 * would have told a user "the faucet is out of EMBER" is unreachable. Dryness is a soft probe here
 * and a field on the body.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { timingSafeEqual } from 'node:crypto'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { ForbiddenError, TokenError, bearerFrom, statusFor, type Principal } from '@cloudsforge/auth'
import type { Db } from './db.ts'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { budgetState, type LimitConfig } from './limits.ts'
import { requesterKey, type RequesterConfig } from './requester.ts'
import { DripRefusedError, acceptDrip, dispenseCounts, readDispense } from './requests.ts'

export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export const READ_SCOPE = 'faucet:read'

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  readonly sql: Db
  /** The operator credential, presented in `x-faucet-token`. Gates `/metrics` and the reads. */
  readonly token: string
  readonly chainId: number
  readonly fundingAddress: string
  readonly limits: LimitConfig
  /**
   * The salt and rotation period the per-requester counter is keyed under. Required rather than
   * defaulted: a `ServerDeps` that could be built without it is a `ServerDeps` that could store a
   * raw address, and the compiler is the cheapest place to refuse that.
   */
  readonly requester: RequesterConfig
  /** Browser origins allowed to POST a drip. An allowlist, never a wildcard. */
  readonly corsOrigins: readonly string[]
  readonly beforeScrape?: () => Promise<void>
}

/** The largest body this service will read. A drip request is about eighty bytes. */
const MAX_BODY_BYTES = 4_096

/** Domain metrics, declared rather than inferred from a log line — AD-20. */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'faucet_up',
      help: 'Always 1. The series that proves the scrape reached the faucet at all.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'faucet_drips_accepted_total',
      help: 'Drip requests queued. A retry recognised as one does not count again.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'faucet_drips_refused_total',
      help: 'Drip requests refused, by code. The number that says whether the limits are working.',
      kind: 'counter',
      labels: ['code'],
    })
    .register({
      name: 'faucet_dispenses_broadcast_total',
      help: 'Transactions handed to a node.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'faucet_dispenses_confirmed_total',
      help: 'Transactions mined to the pinned confirmation depth.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'faucet_dispenses_failed_total',
      help: 'Dispenses that reached a terminal failure, by reason.',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      name: 'faucet_rebroadcasts_deduped_total',
      help: 'Re-broadcasts the node already held. Every one of these is a double-send that did not happen.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'faucet_custody_refusals_total',
      help: 'Signatures custody declined, by code. A non-zero purpose_forbidden here is a misconfigured binding.',
      kind: 'counter',
      labels: ['code'],
    })
    .register({
      name: 'faucet_budget_remaining_wei',
      help: 'What is left of the payout cap in this window. The control that bounds the loss.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'faucet_dispenses',
      help: 'Dispenses by status. A number stuck in broadcast is the one worth alerting on.',
      kind: 'gauge',
      labels: ['status'],
    })
    .register({
      name: 'faucet_dry',
      help: '1 when the funding address cannot cover one more drip. Soft: the queue holds rather than fails.',
      kind: 'gauge',
      labels: [],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
  readonly headers?: Record<string, string>
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
}

interface Route {
  readonly method: string
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `(?<${segment.slice(1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${source}$`)
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    let matched: Route | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url.pathname)
      if (match) {
        matched = route
        params = { ...match.groups }
        break
      }
    }

    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', { method, route: routeLabel, status: String(status) })
      deps.metrics.observe('http_request_duration_ms', durationMs, { method, route: routeLabel })
    }

    void handle(matched, { req, url, requestId, log, params }, deps)
      .then((reply) => {
        send(res, withCors(reply, req, deps), requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500)
      })
  })
}

async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    if (err instanceof DripRefusedError) {
      // A refusal is the limiter working, not a fault, so it is INFO. The message is the limiter's
      // own and is safe to serve: it names a rule and a number, never a balance, an address the
      // caller did not send, or anything about the funding key.
      ctx.log.info('drip refused', { code: err.code })
      deps.metrics.increment('faucet_drips_refused_total', { code: err.code })
      return {
        status: err.status,
        body: { error: { code: err.code, message: err.message, requestId: ctx.requestId } },
        ...(err.retryAfterSeconds !== null
          ? { headers: { 'retry-after': String(err.retryAfterSeconds) } }
          : {}),
      }
    }
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid credential is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof NotFoundError) return errorReply(404, 'not_found', err.message, ctx.requestId)
    if (err instanceof BadRequestError) return errorReply(400, 'bad_request', err.message, ctx.requestId)
    // The caught error's own text is NOT served. It may carry a node URL with a key in its path, a
    // driver message quoting a row, or a custody response. The operator gets it in the log.
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handler })

  return [
    /**
     * Static. It answers 200 from the moment the socket is open until the process is asked to
     * stop, and it consults nothing — that is the entire contract. A liveness probe that touched
     * the database would restart a healthy replica every time Postgres hiccuped, which converts a
     * recoverable dependency outage into a rolling restart of every replica at once.
     */
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      // Gated. An open /metrics here publishes the remaining budget, which tells an attacker
      // exactly how much is left to take and when the window rolls.
      await authorise(ctx, deps)
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    /* ------------------------------------------------------------------ the faucet */

    /**
     * What this faucet is and what it will do. Unauthenticated: a testnet faucet whose terms
     * require a credential to read is a faucet nobody can use.
     *
     * The funding ADDRESS is published, and that is safe and useful — it is public on chain the
     * moment the first drip lands, and an operator topping the faucet up needs it. Nothing else
     * about the key is here, or anywhere.
     */
    define('GET', '/v1/faucet', async (_ctx, deps) => {
      const budget = await budgetState(deps.sql, deps.limits)
      return {
        status: 200,
        body: {
          network: 'testnet',
          chainId: deps.chainId,
          asset: 'EMBER',
          fundingAddress: deps.fundingAddress,
          // Decimal strings, never numbers. 1e19 wei is past what JSON's number type carries
          // exactly, and a client parsing it with JSON.parse would get a rounded value.
          dripWei: deps.limits.dripWei.toString(10),
          addressCooldownSeconds: deps.limits.addressCooldownSeconds,
          requesterLimit: deps.limits.requesterLimit,
          requesterWindowSeconds: deps.limits.requesterWindowSeconds,
          budgetRemainingWei: budget.remainingWei.toString(10),
          budgetWindowSeconds: deps.limits.budgetWindowSeconds,
          terms:
            'Testnet EMBER. It has no value, it is not tradeable, and the chain it funds may be ' +
            'reset without notice.',
        },
      }
    }),

    /**
     * Ask for a drip.
     *
     * 202, not 200. The request is QUEUED — nothing has been signed and no nonce has been read —
     * and the caller polls `GET /v1/drips/:id`. The frozen service broadcasts inside this handler
     * and answers 200 with a hash (`server.js:244-253`); `requests.ts` says why that is a defect.
     *
     * **NOTHING IN THE BODY EXCEPT `address` AND `idempotencyKey` IS READ.** Not an amount, not a
     * token, not a chain id. The drip is a server-side constant.
     */
    define('POST', '/v1/drips', async (ctx, deps) => {
      const payload = await readJson(ctx.req)
      const accepted = await acceptDrip(
        {
          sql: deps.sql,
          chainId: deps.chainId,
          fundingAddress: deps.fundingAddress,
          limits: deps.limits,
        },
        {
          address: payload['address'],
          ...(typeof payload['idempotencyKey'] === 'string'
            ? { idempotencyKey: payload['idempotencyKey'] }
            : {}),
          requester: requesterOf(ctx, deps.requester),
        },
      )
      if (!accepted.duplicate) deps.metrics.increment('faucet_drips_accepted_total')
      return {
        status: accepted.duplicate ? 200 : 202,
        body: {
          id: accepted.id,
          recipient: accepted.recipient,
          amountWei: accepted.amountWei.toString(10),
          status: accepted.status,
          duplicate: accepted.duplicate,
          poll: `/v1/drips/${accepted.id}`,
        },
      }
    }),

    /**
     * Poll a drip. Unauthenticated, and it holds nothing worth gating: the recipient asked for it,
     * the amount is published, and the transaction hash is public on chain. The id is a v4 UUID,
     * so it is not enumerable.
     */
    define('GET', '/v1/drips/:id', async (ctx, deps) => {
      const view = await readDispense(deps.sql, ctx.params['id'] ?? '')
      if (!view) throw new NotFoundError('no such drip')
      return {
        status: 200,
        body: {
          id: view.id,
          recipient: view.recipient,
          status: view.status,
          amountWei: view.amountWei.toString(10),
          txHash: view.txHash,
          confirmations: view.confirmations,
          blockNumber: view.blockNumber === null ? null : view.blockNumber.toString(10),
          failureReason: view.failureReason,
          createdAt: view.createdAt.toISOString(),
          settledAt: view.settledAt?.toISOString() ?? null,
        },
      }
    }),

    // The preflight a browser sends before a cross-origin POST with a JSON content type.
    define('OPTIONS', '/v1/drips', async (ctx, deps) => {
      const origin = headerOf(ctx.req, 'origin')
      if (!origin || !deps.corsOrigins.includes(origin)) return { status: 403 }
      return { status: 204 }
    }),
  ]
}

/* ------------------------------------------------------------------ the scrape refresh */

/** Refresh the gauges once per scrape. Bounded queries: both are aggregates over small tables. */
export function scrapeRefresh(deps: {
  readonly sql: Db
  readonly metrics: Metrics
  readonly limits: LimitConfig
}): () => Promise<void> {
  return async () => {
    deps.metrics.set('faucet_up', 1)
    const budget = await budgetState(deps.sql, deps.limits)
    // A gauge in wei would be a float in Prometheus and 1e21 wei does not survive a double. Whole
    // EMBER is the unit an operator reads anyway, and the rounding is explicitly a display choice
    // made here rather than an accident of the storage type.
    deps.metrics.set('faucet_budget_remaining_wei', Number(budget.remainingWei / 10n ** 15n) / 1_000)
    const counts = await dispenseCounts(deps.sql)
    // Every status every scrape, INCLUDING ZERO: a gauge that simply stops when the last row in a
    // status clears leaves an alert evaluating a stale sample rather than zero.
    for (const status of ['queued', 'signing', 'signed', 'broadcast', 'confirmed', 'failed'] as const) {
      deps.metrics.set('faucet_dispenses', counts.get(status) ?? 0, { status })
    }
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Who is asking, for the per-requester limit.
 *
 * The client address, first hop only. `x-forwarded-for` past the first entry is
 * attacker-appendable, and the first entry is the one the estate's ingress writes.
 *
 * The frozen service makes this a SETTING — `HEARTH_FAUCET_TRUST_PROXY` (`env.js:133`) — and its
 * reasoning is genuinely good: trusted while directly exposed makes the limit decorative, and
 * untrusted while behind a proxy locks the world out after three drips. That is a real dilemma for
 * a tool somebody runs on a laptop. It is not one here, because this service runs in exactly one
 * topology: behind the estate's ingress, always, like every other service in the estate. A setting
 * whose wrong value silently disables a rate limit is a setting worth deleting when the right value
 * is known, so it is deleted.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ADDRESS IS READ HERE AND IS GONE BY THE END OF THIS FUNCTION.** It is not stored, not
 * logged, not returned, and not passed to anything below. `requesterKey` truncates it to a network
 * prefix and keyed-hashes the prefix under a rotating secret, and that opaque key is the only form
 * of it this service has ever had since micro-org#163. `requester.ts` carries the whole argument;
 * `faucet_requester_grants_pseudonymous` is the same rule stated by the schema, so a future edit
 * to this function that put an address back cannot commit it.
 *
 * The old line said "this bounds the lazy case and nothing more — an IPv6 /64 has 2^64 addresses".
 * That sentence was true of a limit keyed on a WHOLE address and it is why the truncation is not a
 * concession: keyed on a /48 that same attacker has one bucket instead of 2^16 of them. The budget
 * is still the control that bounds the loss.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function requesterOf(ctx: RequestContext, requester: RequesterConfig): string {
  const forwarded = headerOf(ctx.req, 'x-forwarded-for')
  // Bounded before it reaches the parser. An unbounded header value is a caller choosing how much
  // work this process does per request, whatever the parser then decides about it.
  const raw = (
    forwarded ? (forwarded.split(',')[0]?.trim() ?? '') : (ctx.req.socket.remoteAddress ?? '')
  ).slice(0, 64)
  return requesterKey(raw, requester)
}

/**
 * Authorise by static token first, then by identity JWT.
 *
 * The static token is checked before the verifier is consulted, so a caller holding it —
 * Prometheus, an operator with the break-glass secret — is never affected by identity being
 * unreachable, which is precisely the state in which someone is trying to read this service.
 */
async function authorise(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const presented = headerOf(ctx.req, 'x-faucet-token')
  if (presented && constantTimeEquals(presented, deps.token)) {
    return { kind: 'service', service: 'faucet-token', scopes: [READ_SCOPE] }
  }
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  if (!token) throw new TokenError('no credential presented', 'missing')
  const principal = await deps.verifier.principal(token)
  if (principal.kind === 'user') return principal
  if (principal.scopes.includes(READ_SCOPE)) return principal
  throw new ForbiddenError(READ_SCOPE)
}

function constantTimeEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** An allowlist, never a wildcard — an unlisted origin gets no CORS headers at all. */
function withCors(reply: Reply, req: IncomingMessage, deps: ServerDeps): Reply {
  const origin = headerOf(req, 'origin')
  if (!origin || !deps.corsOrigins.includes(origin)) return reply
  return {
    ...reply,
    headers: {
      ...(reply.headers ?? {}),
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'origin',
    },
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // REFUSED, not truncated: a truncated JSON body either fails to parse or parses as a prefix
    // that happens to be valid, and the second is a request nobody sent.
    if (size > MAX_BODY_BYTES) throw new BadRequestError(`the request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) throw new BadRequestError('expected a JSON body: {"address":"0x…"}')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BadRequestError('the request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError('expected a JSON object: {"address":"0x…"}')
  }
  return parsed as Record<string, unknown>
}

function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const hasBody = reply.text !== undefined || reply.body !== undefined
  const payload = reply.text ?? (hasBody ? `${JSON.stringify(reply.body ?? {})}\n` : '')
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    'cache-control': 'no-store',
    ...(reply.headers ?? {}),
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
