/**
 * Configuration validation, and **the refusal that matters most**.
 *
 * No database — `loadEnv` takes an explicit source object, so every case here is a pure function of
 * its input. That is deliberate for the testnet gate in particular: the proof that this service
 * cannot be pointed at mainnet must not itself depend on a node, a network or a container.
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { CHAINS } from '@cloudsforge/contracts-chain'

/**
 * GENERATED, NOT WRITTEN, AND THE LITERAL IT REPLACES IS WHY.
 *
 * Every case in this file used to be built on `'a-real-looking-secret-of-sufficient-length'`. It is
 * hyphenated, it is a sentence describing itself, and — read the last two words —
 * `sufficientlength` is one of the placeholder markers `@cloudsforge/secrets` refuses by name. The
 * whole suite was asserting that a value whose own text says it exists to clear a length check is
 * an acceptable operator credential, on the service that is also an unauthenticated withdrawal
 * endpoint pointed at a worthless chain.
 *
 * Regenerated per run rather than replaced with a better-looking literal, so a placeholder cannot
 * creep back in the next time somebody needs a fixture.
 */
const TOKEN = randomBytes(48).toString('base64')

/** A source that satisfies every required variable, so a case can vary exactly one thing. */
function base(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    FAUCET_DATABASE_URL: 'postgres://faucet:faucet@db:5432/faucet',
    IDENTITY_JWKS_URL: 'http://identity:4001/.well-known/jwks.json',
    IDENTITY_ISSUER: 'http://identity:4001',
    FAUCET_TOKEN: TOKEN,
    FAUCET_RPC_URL: 'http://hearth-testnet:8545',
    CUSTODY_URL: 'http://custody:4005',
    // NOT a generated fixture, deliberately, and not a mistake. `CUSTODY_TOKEN` is the one secret
    // in this file that is NOT held to a shape — see the block on it in `env.ts`. The estate feeds
    // it a 669-character JWT because custody's gate requires an identity token and this service has
    // no `ServiceTokenProvider`, so a shape guard here would refuse the only value that works.
    CUSTODY_TOKEN: 'another-real-looking-secret-of-length',
    FAUCET_FUNDING_ADDRESS: '0x00000000000000000000000000000000000000fa',
    FAUCET_CUSTODY_ORDER_ID: 'faucet:ember:testnet',
    FAUCET_CUSTODY_USER_ID: 'cloudsforge:faucet',
    ...overrides,
  }
}

// `env.ts` validates `process.env` at IMPORT and exits the process on a bad configuration — right
// for a service, fatal for a test runner. So populate a valid environment first, then import it
// dynamically. `loadEnv` itself is pure over its source, so every case below passes an explicit
// object and never touches `process.env`.
for (const [key, value] of Object.entries(base())) if (value !== undefined) process.env[key] = value
const { CHAIN_ID, CONFIRMATIONS, DECIMALS, EnvError, NETWORK, emberToWei, loadEnv } = await import('./env.ts')
const { TEST_DSN_VAR } = await import('./testsupport.ts')

describe('the testnet gate', () => {
  /**
   * The whole point, stated once.
   *
   * The chain id is not a variable with a default. It is read from the exact-pinned package, so
   * there is no value of any environment variable that makes this service dispense on 7411.
   */
  it('is the EMBER testnet, taken from the pinned package and not from the environment', () => {
    assert.equal(NETWORK, 'testnet')
    assert.equal(CHAIN_ID, CHAINS.EMBER.chainId?.testnet)
    assert.equal(CHAIN_ID, 7412)
  })

  /**
   * **THE DEFECT IN THE FROZEN SERVICE, NAMED.**
   *
   * `stack/repos/hearth/tools/faucet/src/env.js:94` defaults `chainId` to 7411, and
   * `src/index.js:71-75` only checks that the node AGREES with it. So the frozen faucet's
   * out-of-the-box configuration is EMBER mainnet, and pointing it at a mainnet node passes every
   * check it has. That number is the mainnet id in the estate's own pinned package.
   */
  it('7411 is EMBER MAINNET, and it is what the frozen faucet defaults to', () => {
    assert.equal(CHAINS.EMBER.chainId?.mainnet, 7411)
    assert.notEqual(CHAINS.EMBER.chainId?.mainnet, CHAIN_ID)
  })

  it('refuses to start when FAUCET_CHAIN_ID names EMBER mainnet, and says why', () => {
    assert.throws(
      () => loadEnv(base({ FAUCET_CHAIN_ID: '7411' })),
      (err: unknown) => {
        assert.ok(err instanceof EnvError)
        assert.match(err.message, /7411/)
        assert.match(err.message, /MAINNET/)
        // The message must not offer a way out. A flag that relaxes this is the whole failure.
        assert.match(err.message, /not configurable/)
        return true
      },
    )
  })

  it('refuses any other chain id too, not only mainnet', () => {
    for (const wrong of ['1', '11155111', '31337', '0']) {
      assert.throws(() => loadEnv(base({ FAUCET_CHAIN_ID: wrong })), EnvError, `chain ${wrong} was accepted`)
    }
  })

  it('accepts FAUCET_CHAIN_ID when it agrees, and when it is absent', () => {
    assert.equal(loadEnv(base({ FAUCET_CHAIN_ID: String(CHAIN_ID) })).port, 4013)
    assert.equal(loadEnv(base()).port, 4013)
    // An empty string is "unset", not "zero" — a deploy that templates the variable and leaves it
    // blank must behave as though it had not been named at all.
    assert.equal(loadEnv(base({ FAUCET_CHAIN_ID: '' })).port, 4013)
  })

  it('takes the confirmation depth from the pinned package rather than restating it', () => {
    assert.equal(CONFIRMATIONS, CHAINS.EMBER.confirmations)
    assert.equal(DECIMALS, CHAINS.EMBER.decimals)
    assert.equal(DECIMALS, 18)
  })
})

describe('the key', () => {
  /**
   * Rule 6, proved by absence.
   *
   * There is no variable that accepts key material, so there is no configuration under which this
   * process holds one. The frozen service reads `HEARTH_FAUCET_PRIVATE_KEY` or
   * `HEARTH_FAUCET_KEY_FILE` (`src/env.js:42-43`); neither has a successor here.
   */
  it('has no configuration variable that accepts a private key', () => {
    const env = loadEnv(
      base({
        FAUCET_PRIVATE_KEY: `0x${'b'.repeat(64)}`,
        HEARTH_FAUCET_PRIVATE_KEY: `0x${'b'.repeat(64)}`,
        FAUCET_KEY_FILE: '/run/secrets/faucet.key',
      }),
    )
    const serialised = JSON.stringify(env, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    assert.doesNotMatch(serialised, /b{64}/)
    assert.doesNotMatch(serialised, /faucet\.key/)
    assert.ok(!('privateKey' in env))
  })

  it('requires the funding ADDRESS, which is public, and validates its shape at boot', () => {
    assert.equal(loadEnv(base()).fundingAddress, '0x00000000000000000000000000000000000000fa')
    assert.throws(() => loadEnv(base({ FAUCET_FUNDING_ADDRESS: 'not-an-address' })), EnvError)
    assert.throws(() => loadEnv(base({ FAUCET_FUNDING_ADDRESS: undefined })), EnvError)
  })
})

describe('the required variables', () => {
  it('loads a complete source', () => {
    const env = loadEnv(base())
    assert.equal(env.databaseUrl, 'postgres://faucet:faucet@db:5432/faucet')
    assert.equal(env.custodyOrderId, 'faucet:ember:testnet')
  })

  it('names the missing database variable', () => {
    assert.throws(
      () => loadEnv(base({ FAUCET_DATABASE_URL: undefined })),
      (err: unknown) => {
        assert.ok(err instanceof EnvError)
        assert.match(err.message, /FAUCET_DATABASE_URL/)
        return true
      },
    )
  })

  it('refuses a placeholder secret rather than booting with it', () => {
    assert.throws(() => loadEnv(base({ FAUCET_TOKEN: 'change-me' })), EnvError)
    assert.throws(() => loadEnv(base({ FAUCET_TOKEN: 'short' })), EnvError)
  })

  /**
   * **THE VALUE THIS SERVICE IS RUNNING ON TODAY, PINNED AS A FAILURE.**
   *
   * `deploy/compose/docker-compose.estate.yml` carries
   * `FAUCET_TOKEN: estate-only-faucet-operator-token-00000` on two lines as a HARDCODED literal,
   * and the same string was measured inside `cloudsforge-estate-faucet-1` on 2026-08-05. It is 39
   * characters, so the 24-character floor this service used to apply could never fail for it —
   * which is micro-org #142, and it is why the floor is gone.
   *
   * It is also, because `FAUCET_REQUESTER_SALT` is unset on both estates, the pseudonymisation key
   * for `faucet_requester_grants.requester`. A published token is a published pseudonymisation key.
   *
   * Quoted here because it is an already-public defect value with no secrecy left to protect, and
   * because a test that names the exact string the estate shipped is the only kind that cannot be
   * satisfied by a rule that happens to catch something else.
   */
  it('REFUSES THE VALUE THE ESTATE IS RUNNING, which is the whole of this change', () => {
    assert.throws(
      () => loadEnv(base({ FAUCET_TOKEN: 'estate-only-faucet-operator-token-00000' })),
      (err: unknown) => {
        assert.ok(err instanceof EnvError)
        assert.match(err.message, /FAUCET_TOKEN/)
        assert.match(err.message, /estateonly/)
        // The message names the marker it matched, never the value it matched it in: the fatal
        // handler writes this to stderr and the collector ships it onwards.
        assert.ok(!err.message.includes('estate-only-faucet-operator-token-00000'))
        return true
      },
    )
  })

  /**
   * **CUSTODY_TOKEN IS NOT HELD TO A SHAPE, AND THIS TEST SAYS SO RATHER THAN LETTING IT LOOK LIKE
   * AN OVERSIGHT.**
   *
   * The case above it used to also assert `loadEnv(base({ CUSTODY_TOKEN: 'CHANGE_ME' }))` throws.
   * That assertion is GONE and its removal is deliberate: the estate feeds this variable a
   * 669-character JWT (measured, `cloudsforge-estate-faucet-1`, 2026-08-05) because
   * `index.ts:137` hands the value straight to `HttpClient` as a bearer and custody's gate wants an
   * identity token, and every shape guard in `@cloudsforge/secrets` refuses a JWT by name. Guarding
   * this variable would have crash-looped the faucet on the estate.
   *
   * So the compose default `${FAUCET_CUSTODY_TOKEN:-estate-placeholder-token-0000000000000000}` is
   * still accepted here, and this test pins that fact so nobody reads the gap as a missing line.
   * The honest fix is micro-org #222 — adopt `ServiceTokenProvider`, read
   * `FAUCET_IDENTITY_CREDENTIAL`, and only then guard this with `assertServiceCredential`.
   */
  it('accepts a JWT in CUSTODY_TOKEN, because the estate supplies one and nothing here can', () => {
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${randomBytes(64).toString('base64url')}.${randomBytes(64).toString('base64url')}`
    assert.equal(loadEnv(base({ CUSTODY_TOKEN: jwt })).custodyToken, jwt)
    // Present but empty is still refused — that is `required`, and it is all that is left here.
    assert.throws(() => loadEnv(base({ CUSTODY_TOKEN: '   ' })), /CUSTODY_TOKEN/)
  })

  it('refuses an RPC or custody URL that is not an absolute http(s) URL', () => {
    assert.throws(() => loadEnv(base({ FAUCET_RPC_URL: 'hearth:8545' })), EnvError)
    assert.throws(() => loadEnv(base({ CUSTODY_URL: 'ftp://custody' })), EnvError)
  })

  it('the CI harness reads the database URL under the name CI exports', () => {
    // Guards the one mistake that produces a green build proving nothing: a suite that silently
    // skipped because it looked for a variable the workflow does not set.
    assert.equal(TEST_DSN_VAR, 'FAUCET_TEST_DATABASE_URL')
  })
})

describe('EMBER amounts are exact', () => {
  /**
   * Rule 4 of the brief: a float near an amount is a defect. This is the boundary where a decimal
   * string from a human becomes a number the service does arithmetic on, so it is where the proof
   * belongs.
   */
  it('parses without floating point', () => {
    assert.equal(emberToWei('10', 'X'), 10_000_000_000_000_000_000n)
    assert.equal(emberToWei('0.1', 'X'), 100_000_000_000_000_000n)
    assert.equal(emberToWei('1', 'X'), 10n ** 18n)
    assert.equal(emberToWei('0', 'X'), 0n)
  })

  /**
   * The defect, SHOWN, with the numbers checked rather than assumed.
   *
   * The obvious demonstration — 0.1 EMBER — does not actually demonstrate anything:
   * `Math.round(0.1 * 1e18)` is exactly 1e17, because the double nearest 1e17 is 1e17. Several
   * amounts of that shape recover perfectly, and a test built on one of them would have asserted a
   * falsehood and passed for the wrong reason.
   *
   * These three do not recover, and the assertion is in both directions: the exact parse is right,
   * AND the float route is wrong by a stated amount.
   */
  it('the float route is wrong, at amounts a faucet would really be configured with', () => {
    const viaFloat = (value: string): bigint => BigInt(Math.round(Number(value) * 1e18))

    // 1.1 EMBER: off by 128 wei.
    assert.equal(emberToWei('1.1', 'X'), 1_100_000_000_000_000_000n)
    assert.equal(viaFloat('1.1') - emberToWei('1.1', 'X'), 128n)

    // A million EMBER — a plausible budget — is short by 16,777,216 wei.
    assert.equal(emberToWei('1000000', 'X'), 10n ** 24n)
    assert.equal(viaFloat('1000000') - emberToWei('1000000', 'X'), -16_777_216n)

    // Full precision: nearly ten million wei lost.
    assert.equal(emberToWei('123456.789012345678901234', 'X'), 123_456_789_012_345_678_901_234n)
    assert.equal(viaFloat('123456.789012345678901234') - emberToWei('123456.789012345678901234', 'X'), -9_875_442n)
  })

  it('holds a value far past what a double carries exactly', () => {
    // 1e24 wei is a million EMBER. `Number` starts losing integers at 2^53 ≈ 9.007e15.
    assert.equal(emberToWei('1000000', 'X'), 10n ** 24n)
    assert.equal(emberToWei('123456.789012345678901234', 'X'), 123_456_789_012_345_678_901_234n)
  })

  it('refuses more than eighteen decimal places rather than truncating', () => {
    assert.throws(() => emberToWei('1.0000000000000000001', 'X'), EnvError)
  })

  it('refuses anything that is not a decimal amount', () => {
    for (const bad of ['-1', '1e18', '0x10', 'ten', '', '1.2.3']) {
      assert.throws(() => emberToWei(bad, 'X'), EnvError, `"${bad}" was accepted`)
    }
  })

  it('every amount on the loaded env is a bigint', () => {
    const env = loadEnv(base())
    for (const value of [
      env.limits.dripWei,
      env.limits.budgetWei,
      env.limits.maxRecipientBalanceWei,
      env.limits.reserveWei,
      env.gasPriceWei,
    ]) {
      assert.equal(typeof value, 'bigint')
    }
  })
})

describe('limits that could never serve a request are refused at boot', () => {
  it('refuses a budget below one drip', () => {
    assert.throws(
      () => loadEnv(base({ FAUCET_DRIP_EMBER: '10', FAUCET_BUDGET_EMBER: '5' })),
      (err: unknown) => {
        assert.ok(err instanceof EnvError)
        assert.match(err.message, /could never serve a single request/)
        return true
      },
    )
  })

  it('refuses a recipient ceiling below one drip, which would bar everyone it had funded', () => {
    assert.throws(
      () => loadEnv(base({ FAUCET_DRIP_EMBER: '10', FAUCET_MAX_RECIPIENT_EMBER: '5' })),
      (err: unknown) => {
        assert.ok(err instanceof EnvError)
        assert.match(err.message, /permanently over the ceiling/)
        return true
      },
    )
  })

  it('allows a zero ceiling, which disables the rule', () => {
    assert.equal(loadEnv(base({ FAUCET_MAX_RECIPIENT_EMBER: '0' })).limits.maxRecipientBalanceWei, 0n)
  })

  it('refuses a zero drip', () => {
    assert.throws(() => loadEnv(base({ FAUCET_DRIP_EMBER: '0' })), EnvError)
  })
})

/* ================================================ the requester's privacy budget. #163 */

/**
 * The configuration behind `requester.ts`: a secret that cannot be a constant, and a period that
 * cannot be long enough to matter or short enough to break the limit it bounds.
 *
 * **No case prints a salt.** They compare derived keys and lengths; the values themselves never
 * reach an assertion message.
 */
describe('the requester salt and its retention period', () => {
  it('defaults the period to two windows rather than to FAUCET_RETENTION_DAYS', () => {
    const env = loadEnv(base())
    assert.equal(env.requester.retentionSeconds, 172_800)
    assert.equal(env.requester.retentionSeconds, 2 * env.limits.requesterWindowSeconds)
    // Thirty days is right for a payout ledger and indefensible for a rate limiter's counter, so
    // the two periods are separate numbers and this is what says so.
    assert.equal(env.retentionDays, 30)
    assert.notEqual(env.requester.retentionSeconds, env.retentionDays * 86_400)
  })

  /**
   * The failure this refuses is a privacy setting that silently disables a rate limit: a prune
   * horizon inside the window would delete counters that are still counting, and every requester
   * would get unlimited drips with nothing in any log to say why.
   */
  it('refuses a retention period shorter than the window it is supposed to outlive', () => {
    assert.throws(
      () =>
        loadEnv(
          base({ FAUCET_REQUESTER_WINDOW_SECONDS: '86400', FAUCET_REQUESTER_RETENTION_SECONDS: '3600' }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof EnvError)
        assert.match(err.message, /would stop refusing anybody/)
        return true
      },
    )
  })

  it('accepts a period equal to the window, and one a small multiple above it', () => {
    assert.equal(
      loadEnv(base({ FAUCET_REQUESTER_WINDOW_SECONDS: '3600', FAUCET_REQUESTER_RETENTION_SECONDS: '3600' }))
        .requester.retentionSeconds,
      3_600,
    )
    assert.equal(
      loadEnv(base({ FAUCET_REQUESTER_RETENTION_SECONDS: '604800' })).requester.retentionSeconds,
      604_800,
    )
  })

  it('bounds the period, so it cannot be set to a year by a typo', () => {
    assert.throws(() => loadEnv(base({ FAUCET_REQUESTER_RETENTION_SECONDS: '31536000' })), EnvError)
    assert.throws(() => loadEnv(base({ FAUCET_REQUESTER_RETENTION_SECONDS: '0' })), EnvError)
    assert.throws(() => loadEnv(base({ FAUCET_REQUESTER_RETENTION_SECONDS: 'never' })), EnvError)
  })

  /**
   * **THERE IS NO CONSTANT DEFAULT SALT.** A pseudonymisation key committed to a repository is a
   * pseudonymisation key that does not exist — it would boot, pass every test and protect nothing.
   * Unset means DERIVED from a secret the deployment already had to provide, so the salt is never
   * weaker than `FAUCET_TOKEN` and is never a value anybody can read out of this checkout.
   */
  it('derives the salt from FAUCET_TOKEN when the dedicated variable is unset', () => {
    // The two tokens were `the-first-operator-token-of-length-x` and its `-second-` twin, whose
    // names say what they were: two hyphenated strings chosen to be long enough. Generated now, and
    // the "does not carry its input through" assertion is made against the generated value rather
    // than against a substring somebody chose to look for.
    const first = randomBytes(48).toString('base64')
    const second = randomBytes(48).toString('base64')
    const one = loadEnv(base({ FAUCET_TOKEN: first })).requester.salt
    const two = loadEnv(base({ FAUCET_TOKEN: second })).requester.salt
    assert.notEqual(one, two, 'the salt must move when the secret it is derived from moves')
    assert.equal(one.length, 64)
    assert.ok(!one.includes(first), 'the derivation must not carry its input through')
    // 64 hex characters is 32 BYTES, which is the floor `@cloudsforge/secrets` holds an explicitly
    // set salt to. The default must not be weaker than the value it is a default for.
    assert.match(one, /^[0-9a-f]{64}$/)
  })

  it('prefers the dedicated variable when it is set, so the two can rotate independently', () => {
    // Was `'a-dedicated-pseudonymisation-salt-value'` — 39 hyphenated characters, past the old
    // 32-character floor and carrying 28 bytes, asserted here as a VALID pseudonymisation key.
    const dedicated = randomBytes(48).toString('base64')
    const env = loadEnv(base({ FAUCET_REQUESTER_SALT: dedicated }))
    assert.equal(env.requester.salt, dedicated)
    assert.notEqual(env.requester.salt, loadEnv(base()).requester.salt)
  })

  /**
   * Optional is not the same as unvalidated. A variable that accepts whatever is set because it
   * has a fallback is how a placeholder ends up being the thing that pseudonymises personal data.
   *
   * This one is `assertGeneratedSecret` and not `assertOpaqueSecret`, unlike `FAUCET_TOKEN`: the
   * estate generates this key and controls its alphabet — its own derived default is 64 hex
   * characters — so the stricter rule is the correct one and costs an operator nothing.
   */
  it('holds an optional salt to the estate’s GENERATED-key rule, not to a keystroke floor', () => {
    assert.throws(() => loadEnv(base({ FAUCET_REQUESTER_SALT: 'changeme' })), /known placeholder/)
    // The assertion here used to demand the message say "at least 32 characters" — the keystroke
    // floor. It is BYTES now, and the message says which: `too-short` is spelled in neither the
    // base64 nor the hex alphabet, so it fails on the alphabet before it can fail on length.
    assert.throws(
      () => loadEnv(base({ FAUCET_REQUESTER_SALT: 'too-short' })),
      (err: unknown) => err instanceof EnvError && /not base64 or hex/.test(err.message),
    )
    // 32 characters of base64 is 24 BYTES. This is the exact shape the old floor waved through: it
    // counted keystrokes, and keystrokes are not the unit an HMAC key is measured in.
    assert.throws(
      () => loadEnv(base({ FAUCET_REQUESTER_SALT: 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4' })),
      (err: unknown) =>
        err instanceof EnvError && /24 bytes of key material/.test(err.message) && /at least 32/.test(err.message),
    )
  })

  it('never puts the salt anywhere a log line would find it', () => {
    // The salt is one field on one object. It is not in `limits`, not in the boot log's shape, and
    // not spread into anything — so this is the shape assertion that keeps it that way.
    const env = loadEnv(base({ FAUCET_REQUESTER_SALT: randomBytes(48).toString('base64') }))
    assert.deepEqual(Object.keys(env.requester).sort(), ['retentionSeconds', 'salt'])
    assert.ok(!Object.keys(env.limits).includes('salt'))
    assert.ok(!Object.keys(env).some((key) => key.toLowerCase().includes('salt')))
  })
})
