/**
 * Addresses, and the one typo protection a 20-byte EVM address has.
 *
 * Ported from `stack/repos/hearth/tools/faucet/src/address.js`, whose rule is right and is
 * kept verbatim in substance: a MIXED-CASE address is claiming an EIP-55 checksum and is held to
 * it; an all-one-case address is not claiming one and is accepted. Rejecting all-lowercase would
 * refuse the output of half the tooling in the ecosystem, and accepting a failed mixed-case
 * checksum would send EMBER to an address somebody mistyped, which is unrecoverable.
 *
 * Two things changed in the port and both are structural rather than stylistic:
 *
 *   1. **The keccak comes from a declared dependency, not from a relative path into a sibling.**
 *      The frozen module reaches out with `require('../../../node/src/crypto/keccak')`
 *      (`address.js`), which is what made the faucet un-deployable as a service: its Dockerfile
 *      has to build from the whole Hearth repository root and hand-copy six paths out of the node's
 *      source tree (`stack/repos/hearth/tools/faucet/Dockerfile:12-18`). It now comes from
 *      `@cloudsforge/evm`, which is the same fix one level up: a package boundary rather than a
 *      path that only resolves inside one checkout.
 *   2. **A refusal is a typed error, not an `{ok:false, reason}` record.** The route maps it to a
 *      400; nothing else in the estate returns a result object for this.
 *
 * The `ember1…` refusal is kept and so is its wording. It is the one wrong input a real user
 * actually arrives with — the pre-EVM UTXO-era address format — and a message that names it saves
 * the round trip that "address must be 0x followed by 40 hex characters" would cost.
 */
import { toChecksumAddress } from '@cloudsforge/evm'

const EVM_SHAPE = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export class AddressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AddressError'
  }
}

/**
 * EIP-55 checksum encoding, from `@cloudsforge/evm`.
 *
 * Re-exported rather than imported directly by callers so that `address.ts` stays the one place
 * this service asks about addresses. The implementation moved out because five services had a
 * byte-identical copy of it, and a checksum that five services compute two ways is a withdrawal
 * refused for an address copied out of our own UI.
 */
export { toChecksumAddress }

/**
 * Validate a recipient and produce the display form, or throw.
 *
 * Pure, and the first thing `POST /v1/drips` does, because it is free and it rejects most abuse
 * before anything costs a database round trip — the cheapest-first ordering the frozen service
 * documents at `src/server.js` and which is worth keeping.
 */
export function parseRecipient(raw: unknown): string {
  if (typeof raw !== 'string') throw new AddressError('address must be a string')
  const trimmed = raw.trim()
  if (!EVM_SHAPE.test(trimmed)) {
    if (trimmed.startsWith('ember1')) {
      throw new AddressError(
        'that is an `ember1…` address from the pre-EVM chain; it cannot receive funds here. ' +
          'Use a 0x address.',
      )
    }
    throw new AddressError('address must be 0x followed by 40 hex characters')
  }
  const lower = trimmed.toLowerCase()
  const isAllOneCase = trimmed === lower || trimmed === `0x${trimmed.slice(2).toUpperCase()}`
  if (!isAllOneCase && toChecksumAddress(lower) !== trimmed) {
    throw new AddressError('EIP-55 checksum failed — check for a typo rather than lowercasing it')
  }
  if (lower === ZERO_ADDRESS) throw new AddressError('refusing to fund the zero address')
  return toChecksumAddress(lower)
}

/** True when two addresses name the same account, whatever their spelling. */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * The key an address is stored and compared under, everywhere in this service.
 *
 * Lower case, always. The database's uniqueness and cooldown guarantees are worth exactly as much
 * as this function is consistent: `0xAb…` and `0xab…` are one account, and a unique index over the
 * display form would hand a second drip to anyone who changed the case of one letter.
 */
export function addressKey(address: string): string {
  return address.toLowerCase()
}
