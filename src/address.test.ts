/**
 * Addresses and the keccak underneath them.
 *
 * Pure, and first in the request path, because a wrong answer here sends EMBER to an address
 * nobody can recover it from.
 *
 * The keccak checks are the ones settlement's own header argues for
 * (`settlement/src/keccak.ts:16-25`) and the second is the strong one: the permutation is compared
 * against **Node's own SHA3-256** over inputs of every length around the 136-byte rate boundary.
 * `sha3_256` is this exact sponge with the NIST padding byte, so if the permutation, the rate, the
 * lane packing or the absorb loop were wrong in any way it would disagree with OpenSSL. That leaves
 * precisely one constant — the domain byte — unverified by it, which the published vector pins.
 */

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { keccak256, sha3_256 } from './keccak.ts'
import { AddressError, addressKey, parseRecipient, sameAddress, toChecksumAddress } from './address.ts'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

describe('keccak-256', () => {
  it('matches the published empty-input vector', () => {
    // Also the vector in Hearth's own EVM spec. This is what pins the Ethereum domain byte (0x01)
    // as distinct from NIST SHA3's (0x06) — the two are the same permutation otherwise, so
    // reaching for createHash('sha3-256') would produce plausible-looking wrong addresses.
    assert.equal(
      hex(keccak256(new Uint8Array())),
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    )
  })

  it('agrees with OpenSSL SHA3-256 over every length around the rate boundary', () => {
    // 136 is the rate for a 256-bit sponge. The absorb loop, the padding and the lane packing all
    // change behaviour across it, so the lengths either side are where a bug would hide.
    for (let length = 0; length <= 300; length++) {
      const input = randomBytes(length)
      assert.equal(
        hex(sha3_256(input)),
        createHash('sha3-256').update(input).digest('hex'),
        `disagreed at length ${length}`,
      )
    }
  })

  it('is not SHA3-256 — the domain byte differs', () => {
    const input = Buffer.from('cloudsforge')
    assert.notEqual(hex(keccak256(input)), createHash('sha3-256').update(input).digest('hex'))
  })
})

describe('EIP-55', () => {
  it('produces the vectors from the EIP itself', () => {
    for (const address of [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ]) {
      assert.equal(toChecksumAddress(address.toLowerCase()), address)
    }
  })
})

describe('parsing a recipient', () => {
  const LOWER = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'
  const CHECKSUMMED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'

  it('accepts all-lowercase, which claims no checksum', () => {
    assert.equal(parseRecipient(LOWER), CHECKSUMMED)
  })

  it('accepts all-uppercase, which also claims no checksum', () => {
    assert.equal(parseRecipient(`0x${LOWER.slice(2).toUpperCase()}`), CHECKSUMMED)
  })

  it('accepts a correct mixed-case checksum', () => {
    assert.equal(parseRecipient(CHECKSUMMED), CHECKSUMMED)
  })

  /**
   * The case that matters: a mixed-case address is CLAIMING a checksum and is held to it. One
   * character of the wrong case is a typo somewhere, and funding a mistyped address is
   * unrecoverable.
   */
  it('refuses a mixed-case address whose checksum fails', () => {
    const mistyped = `0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD` // final d upper-cased
    assert.notEqual(mistyped, CHECKSUMMED)
    assert.throws(() => parseRecipient(mistyped), (err: unknown) => {
      assert.ok(err instanceof AddressError)
      assert.match(err.message, /EIP-55/)
      // The message must not suggest lowercasing it, which is the thing a user would try and which
      // would fund the typo.
      assert.match(err.message, /check for a typo/)
      return true
    })
  })

  it('names the pre-EVM ember1 format rather than answering "not 40 hex characters"', () => {
    assert.throws(() => parseRecipient('ember1qw508d6qejxtdg4y5r3zarvary0c5xw7k'), (err: unknown) => {
      assert.ok(err instanceof AddressError)
      assert.match(err.message, /pre-EVM/)
      return true
    })
  })

  it('refuses the zero address, from which nothing is recoverable', () => {
    assert.throws(
      () => parseRecipient('0x0000000000000000000000000000000000000000'),
      (err: unknown) => {
        assert.ok(err instanceof AddressError)
        assert.match(err.message, /zero address/)
        return true
      },
    )
  })

  it('refuses everything that is not an address', () => {
    for (const bad of [
      undefined,
      null,
      42,
      {},
      [],
      '',
      '0x',
      '0x123',
      `0x${'0'.repeat(41)}`,
      `0x${'g'.repeat(40)}`,
      '5aaeb6053f3e94c9b9a09f33669435e7ef1beaed',
    ]) {
      assert.throws(() => parseRecipient(bad), AddressError, `${JSON.stringify(bad)} was accepted`)
    }
  })

  it('trims surrounding whitespace, which a paste carries', () => {
    assert.equal(parseRecipient(`  ${CHECKSUMMED}\n`), CHECKSUMMED)
  })
})

describe('one account has one key', () => {
  /**
   * The database's uniqueness and cooldown guarantees are worth exactly as much as this is
   * consistent. If `0xAb…` and `0xab…` keyed differently, changing the case of one letter would
   * buy a second drip.
   */
  it('keys every spelling of one address identically', () => {
    const spellings = [
      '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed',
      '0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED',
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    ]
    const keys = new Set(spellings.map((s) => addressKey(parseRecipient(s))))
    assert.equal(keys.size, 1)
    assert.equal([...keys][0], '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')
  })

  it('compares two spellings as the same account', () => {
    assert.ok(sameAddress('0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'))
    assert.ok(!sameAddress('0x' + '1'.repeat(40), '0x' + '2'.repeat(40)))
  })

  it('the key always matches the column CHECK, which is lower case', () => {
    const shape = /^0x[0-9a-f]{40}$/
    for (let i = 1; i < 40; i++) {
      assert.match(addressKey(parseRecipient(`0x${i.toString(16).padStart(40, 'a')}`)), shape)
    }
  })
})
