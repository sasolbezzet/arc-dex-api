// e2e-webauthn.mjs — simulate a WebAuthn P-256 passkey in Node for E2E tests.
//
// Builds a real registration credential (fmt "none" attestation) for Circle's
// rp_getRegistrationOptions / rp_getRegistrationVerification and provides a
// getFn that signs WebAuthn assertions with the same P-256 key, so viem's
// toWebAuthnAccount / toCircleSmartAccount work headlessly.
//
// All WebAuthn encoding (authenticatorData, COSE key, attestationObject,
// clientDataJSON) is delegated to ox, which viem itself uses, so the wire
// format matches what a real browser authenticator produces.
import { webcrypto } from 'node:crypto'
import { WebCryptoP256, Bytes, P256 } from 'ox'
import { Authenticator } from 'ox/webauthn'

const encoder = new TextEncoder()

// Must match the origin bound to the Circle Client Key in Circle Console.
export const PASSKEY_ORIGIN = 'https://arcoxdex.vercel.app'

const bytesToB64Url = (bytes) => Buffer.from(bytes).toString('base64url')

async function sha256(data) {
  return new Uint8Array(await webcrypto.subtle.digest('SHA-256', data))
}

/**
 * Generate a P-256 keypair + a synthetic WebAuthn registration credential.
 * Returns { privateKey (CryptoKey), publicKey (ox PublicKey), credentialId,
 * credential (JSON-RPC body for rp_*), rpIdHash }.
 */
export async function createPasskey({ rpId, challenge }) {
  const { privateKey, publicKey } = await WebCryptoP256.createKeyPair({ extractable: true })
  const credentialId = webcrypto.getRandomValues(new Uint8Array(32))

  // clientDataJSON must carry the EXACT challenge string Circle issued, so
  // build it manually rather than re-encoding (base64url -> hex -> base64url
  // could alter padding/round-trip).

  // authenticatorData: rpIdHash || flags(UP|UV|AT) || signCount || AAGUID ||
  // credIdLen || credentialId || COSE public key (canonical, via ox CoseKey).
  const authData = Authenticator.getAuthenticatorData({
    rpId,
    flag: 0x45, // UP(0x01) | UV(0x04) | AT(0x40)
    credential: { id: credentialId, publicKey },
  })

  // attestationObject = CBOR { fmt: 'none', attStmt: {}, authData } via ox.
  const attestationObject = Authenticator.getAttestationObject({ authData })

  const clientDataJSON = JSON.stringify({
    type: 'webauthn.create',
    challenge,
    origin: PASSKEY_ORIGIN,
    crossOrigin: false,
  })

  const credential = {
    id: bytesToB64Url(credentialId),
    rawId: bytesToB64Url(credentialId),
    type: 'public-key',
    response: {
      clientDataJSON: bytesToB64Url(encoder.encode(clientDataJSON)),
      attestationObject: bytesToB64Url(Bytes.fromHex(attestationObject)),
      transports: ['internal'],
    },
  }

  const rpIdHash = await sha256(encoder.encode(rpId))
  return { privateKey, publicKey, credentialId, credential, rpIdHash }
}

/**
 * Build the getFn that viem's toWebAuthnAccount calls to produce assertions.
 * Signs (authenticatorData || sha256(clientDataJSON)) with the P-256 key.
 */
export function makePasskeyGetFn({ privateKey, credentialId, rpId }) {
  return async (requestOptions) => {
    const challenge = new Uint8Array(requestOptions.publicKey.challenge)
    const clientDataJSON = JSON.stringify({
      type: 'webauthn.get',
      challenge: bytesToB64Url(challenge),
      origin: PASSKEY_ORIGIN,
      crossOrigin: false,
    })
    const clientDataJSONBytes = encoder.encode(clientDataJSON)
    const rpIdHash = await sha256(encoder.encode(rpId))
    // Assertion flags: UP(0x01) | UV(0x04) = 0x05 (no attested credential data)
    const authenticatorData = Buffer.concat([Buffer.from(rpIdHash), Buffer.from([0x05, 0x00, 0x00, 0x00, 0x00])])
    const signedData = Buffer.concat([authenticatorData, Buffer.from(await sha256(clientDataJSONBytes))])
    // WebCrypto subtle.sign returns IEEE P1363 (r||s, 64 bytes), but viem/ox
    // parse the assertion as ASN.1 DER, so convert r,s into DER before
    // returning (same as a real browser authenticator would produce).
    const rawSig = new Uint8Array(
      await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, signedData),
    )
    const signature = P256.noble.Signature.fromCompact(rawSig).toDERRawBytes()
    return {
      id: bytesToB64Url(credentialId),
      response: {
        clientDataJSON: clientDataJSONBytes,
        authenticatorData: new Uint8Array(authenticatorData),
        signature,
      },
    }
  }
}
