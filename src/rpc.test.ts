/**
 * The JSON-RPC client, over a real socket.
 *
 * No database and no Hearth node: a stub HTTP server answers, so every case here — including the
 * ones a real node would only produce on a bad day — runs anywhere. `indexer/src/hearth.test.ts`
 * skips when no node is reachable, which is honest and also means those cases prove nothing on a
 * machine without one. Nothing in this file skips.
 *
 * The two cases that matter most are the ones the frozen client earned the hard way: an endpoint
 * that answers `{"err":…}` at HTTP 200, which is Hearth's UTXO-era REST API on a neighbouring port,
 * and a node that already holds a transaction.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AlreadyKnownError, Rpc, RpcError, RpcUnavailableError, quantity, smallInteger } from './rpc.ts'

describe('the node client', () => {
  let server: Server
  let url: string
  /** What the stub answers next. A string is written verbatim; an object is JSON-RPC-wrapped. */
  let answer: (method: string) => unknown | string
  let status = 200

  before(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const method = (JSON.parse(body) as { method: string }).method
        const value = answer(method)
        const payload =
          typeof value === 'string' ? value : JSON.stringify({ jsonrpc: '2.0', id: 1, ...(value as object) })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(payload)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const client = () => new Rpc({ url, deadlineMs: 2_000 })

  /* ---------------------------------------------------------------- quantities */

  describe('hex quantities are exact in both directions', () => {
    it('parses a QUANTITY as a bigint', () => {
      assert.equal(quantity('0x0', 'x'), 0n)
      assert.equal(quantity('0x1cf4', 'x'), 7412n)
      // 1e24 wei — a million EMBER. Well past what a double carries.
      assert.equal(quantity('0xd3c21bcecceda1000000', 'x'), 10n ** 24n)
    })

    /**
     * A malformed quantity must THROW, never read as zero. `parseInt` of a bad quantity is a
     * partial parse and `Number('0x')` is NaN; a balance silently read as zero is a faucet that
     * reports itself dry and refuses everybody.
     */
    it('refuses anything that is not a QUANTITY rather than reading it as zero', () => {
      for (const bad of ['0x', '', '1234', 'null', null, undefined, 42, {}]) {
        assert.throws(() => quantity(bad, 'x'), RpcUnavailableError, `${JSON.stringify(bad)} was accepted`)
      }
    })

    /**
     * Custody refuses a non-safe-integer nonce rather than rounding it
     * (`custody/src/signing.ts`), so a nonce past 2^53 must fail HERE, loudly, rather than
     * arriving there as a rounded number that signs a transaction nobody asked for.
     */
    it('refuses a small-integer quantity that is not actually small', () => {
      assert.equal(smallInteger('0x1cf4', 'x'), 7412)
      assert.equal(smallInteger(`0x${Number.MAX_SAFE_INTEGER.toString(16)}`, 'x'), Number.MAX_SAFE_INTEGER)
      assert.throws(() => smallInteger('0x20000000000000', 'x'), /safe integer/)
    })
  })

  /* ---------------------------------------------------------------- the reads */

  describe('the reads', () => {
    it('reads the chain id, the height, a balance and a nonce', async () => {
      answer = (method) =>
        ({
          eth_chainId: { result: '0x1cf4' },
          eth_blockNumber: { result: '0x3e8' },
          eth_getBalance: { result: '0x8ac7230489e80000' },
          eth_getTransactionCount: { result: '0x2a' },
        })[method] ?? { result: null }

      const rpc = client()
      assert.equal(await rpc.chainId(), 7412)
      assert.equal(await rpc.blockNumber(), 1_000n)
      assert.equal(await rpc.getBalance('0x1'), 10n ** 19n)
      assert.equal(await rpc.getNonce('0x1'), 42)
    })

    it('a null receipt is an ANSWER — the transaction is still in the mempool', async () => {
      answer = () => ({ result: null })
      assert.equal(await client().getTransactionReceipt(`0x${'a'.repeat(64)}`), null)
    })

    it('reads a receipt, and treats an absent status as success', async () => {
      answer = () => ({ result: { blockNumber: '0x3e8', status: '0x1' } })
      assert.deepEqual(await client().getTransactionReceipt(`0x${'a'.repeat(64)}`), {
        blockNumber: 1_000n,
        status: true,
      })
      // Absent is read as success rather than as failure: that is the direction that does not mark
      // a mined payment as lost. Hearth's EVM is post-Byzantium so this cannot arise in practice.
      answer = () => ({ result: { blockNumber: '0x3e8' } })
      assert.equal((await client().getTransactionReceipt(`0x${'a'.repeat(64)}`))?.status, true)
      answer = () => ({ result: { blockNumber: '0x3e8', status: '0x0' } })
      assert.equal((await client().getTransactionReceipt(`0x${'a'.repeat(64)}`))?.status, false)
    })
  })

  /* ---------------------------------------------------------------- errors */

  describe('what the node says when it says no', () => {
    it('a JSON-RPC error is a peer decision', async () => {
      answer = () => ({ error: { code: -32_000, message: 'intrinsic gas too low' } })
      await assert.rejects(client().blockNumber(), (err: unknown) => {
        assert.ok(err instanceof RpcError)
        assert.equal(err.code, -32_000)
        return true
      })
    })

    /**
     * **THE MISCONFIGURATION THAT COSTS AN AFTERNOON**, carried across from the frozen client
     * (`rpc.js`) and reconfirmed against the running node: a POST to 127.0.0.1:8647 answers
     * `{"err":"this is the REST API — the Ethereum JSON-RPC endpoint is a different port"}` at HTTP
     * 200. That parses as JSON, so without this check the symptom is "cannot convert undefined to
     * BigInt" four frames from the cause.
     */
    it('names the UTXO-era REST API when it answers on the wrong port', async () => {
      answer = () => '{"err":"this is the REST API — the Ethereum JSON-RPC endpoint is a different port"}'
      await assert.rejects(client().chainId(), (err: unknown) => {
        assert.ok(err instanceof RpcUnavailableError)
        assert.match(err.message, /UTXO-era REST API/)
        assert.match(err.message, /not the eth_\* endpoint/)
        return true
      })
    })

    it('names a body that is not JSON at all', async () => {
      answer = () => '<html>502 Bad Gateway</html>'
      await assert.rejects(client().chainId(), (err: unknown) => {
        assert.ok(err instanceof RpcUnavailableError)
        assert.match(err.message, /did not return JSON/)
        return true
      })
    })

    it('an unreachable node is unavailable, not a peer decision', async () => {
      // A port with nothing on it.
      const dead = new Rpc({ url: 'http://127.0.0.1:1', deadlineMs: 1_000 })
      await assert.rejects(dead.chainId(), RpcUnavailableError)
    })

    /**
     * A node URL may carry a key in its path — an Infura-shaped endpoint does — so the path is
     * never in an error message. Rule 6's neighbourhood: the credential this service holds is
     * custody's, but a node URL is the other thing worth not echoing.
     */
    it('never puts the node URL path in an error message', async () => {
      const withKey = new Rpc({ url: `${url}/v3/deadbeefsecretprojectid`, deadlineMs: 2_000 })
      answer = () => '<html>nope</html>'
      await assert.rejects(withKey.chainId(), (err: unknown) => {
        assert.ok(err instanceof RpcUnavailableError)
        assert.doesNotMatch(err.message, /deadbeefsecretprojectid/)
        assert.match(err.message, /127\.0\.0\.1/)
        return true
      })
    })
  })

  /* ---------------------------------------------------------------- broadcasting */

  describe('broadcasting', () => {
    it('returns the hash, lower-cased', async () => {
      answer = () => ({ result: `0x${'AB'.repeat(32)}` })
      assert.equal(await client().sendRawTransaction('0xdead'), `0x${'ab'.repeat(32)}`)
    })

    it('refuses a response that is not a transaction hash', async () => {
      answer = () => ({ result: 'ok' })
      await assert.rejects(client().sendRawTransaction('0xdead'), RpcUnavailableError)
    })

    /**
     * **THE EXACTLY-ONCE DISCRIMINATOR.** Every wording a node might use for "I already have this"
     * must become `AlreadyKnownError`, which `dispense.ts` reads as the success it is. Reading any
     * of these as a failure would either abandon a payment that is already on chain or, far worse,
     * sign a replacement on a fresh nonce.
     */
    it('recognises every wording of "I already have this"', async () => {
      for (const message of [
        'already known',
        'known transaction: 0xabc',
        'ALREADY_EXISTS',
        'nonce too low',
        'replacement transaction underpriced',
      ]) {
        answer = () => ({ error: { code: -32_000, message } })
        await assert.rejects(client().sendRawTransaction('0xdead'), (err: unknown) => {
          assert.ok(err instanceof AlreadyKnownError, `"${message}" was not recognised`)
          return true
        })
      }
    })

    it('does not mistake an ordinary refusal for "already known"', async () => {
      for (const message of ['insufficient funds for gas * price + value', 'intrinsic gas too low', 'invalid sender']) {
        answer = () => ({ error: { code: -32_000, message } })
        await assert.rejects(client().sendRawTransaction('0xdead'), (err: unknown) => {
          assert.ok(err instanceof RpcError, `"${message}" was misread as already-known`)
          assert.ok(!(err instanceof AlreadyKnownError))
          return true
        })
      }
    })
  })
})
