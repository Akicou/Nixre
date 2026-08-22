// Server-side WebAuthn verification for passkey login — no dependencies.
//
// Registrations store the credential's COSE public key (base64url). Login is
// a two-step ceremony: POST /webauthn/login-challenge issues a single-use
// server challenge (kept in memory, 2-minute TTL), the browser produces a
// navigator.credentials assertion against it, and POST /webauthn/login
// verifies the assertion signature here before minting a session.
//
// Supported algorithms: ES256 (P-256), RS256, Ed25519 — everything the
// registration UI offers.

import crypto from 'node:crypto';

const CHALLENGE_TTL_MS = 2 * 60 * 1000;

/** @type {Map<string, {expires: number}>} */
const challenges = new Map();

export function newChallenge() {
  const challenge = crypto.randomBytes(32).toString('base64url');
  sweepChallenges();
  challenges.set(challenge, { expires: Date.now() + CHALLENGE_TTL_MS });
  return challenge;
}

export function takeChallenge(challenge) {
  sweepChallenges();
  const entry = challenges.get(String(challenge || ''));
  if (!entry) return false;
  challenges.delete(challenge);
  return entry.expires > Date.now();
}

function sweepChallenges() {
  const now = Date.now();
  for (const [key, entry] of challenges) {
    if (entry.expires < now) challenges.delete(key);
  }
}

// --- COSE (RFC 9052) → node KeyObject ----------------------------------------

// COSE key labels: 1 kty, 3 alg, -1 crv, -2 x / n, -3 y / e
const KTY = { 2: 'EC', 3: 'RSA' };
const COSE_ALG = { '-7': 'ES256', '-257': 'RS256', '-8': 'Ed25519' };

function b64urlToBuffer(s) {
  return Buffer.from(String(s || ''), 'base64url');
}

/**
 * Parse a COSE CBOR key (base64url) into a node KeyObject. Only the shapes
 * browsers emit for the algs we offer are accepted. Minimal CBOR decoder:
 * the keys are small maps of integers and byte strings.
 */
export function coseToKeyObject(coseB64url) {
  const buf = b64urlToBuffer(coseB64url);
  const decoded = decodeCbor(buf);
  if (!decoded || typeof decoded !== 'object') {
    throw new Error('malformed COSE key');
  }
  const kty = KTY[decoded[1]];
  if (kty === 'EC') {
    const crv = decoded[-1];
    if (crv !== 1) throw new Error('only P-256 curves are supported');
    const x = decoded[-2];
    const y = decoded[-3];
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
      throw new Error('malformed EC coordinates');
    }
    return crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') },
      format: 'jwk',
    });
  }
  if (kty === 'RSA') {
    const n = decoded[-1];
    const e = decoded[-2];
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) {
      throw new Error('malformed RSA modulus');
    }
    return crypto.createPublicKey({
      key: { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') },
      format: 'jwk',
    });
  }
  if (decoded[1] === 1) {
    // OKP (Ed25519)
    const crv = decoded[-1];
    const x = decoded[-2];
    if (crv !== 6 || !Buffer.isBuffer(x) || x.length !== 32) {
      throw new Error('only Ed25519 is supported');
    }
    return crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') },
      format: 'jwk',
    });
  }
  throw new Error('unsupported key type');
}

/** Alg name ('ES256' | 'RS256' | 'Ed25519') from a COSE alg label, or null. */
export function algNameFromCoseLabel(label) {
  return COSE_ALG[String(label)] || null;
}

// Minimal CBOR decoder for COSE keys: unsigned ints, negative ints (major 1),
// byte strings (major 2), text strings (major 3), and finite maps (major 5).
// Indefinite lengths and tags are not needed for browser-produced keys.
function decodeCbor(buf) {
  let pos = 0;
  function readHead() {
    const first = buf[pos++];
    const major = first >> 5;
    let info = first & 0x1f;
    if (info === 24) info = buf[pos++];
    else if (info === 25) {
      info = buf.readUInt16BE(pos);
      pos += 2;
    } else if (info === 26) {
      info = buf.readUInt32BE(pos);
      pos += 4;
    } else if (info > 27) {
      throw new Error('unsupported CBOR header');
    }
    return { major, info };
  }
  function readItem() {
    const { major, info } = readHead();
    if (major === 0) return info;
    if (major === 1) return -1 - info;
    if (major === 2) {
      const out = buf.subarray(pos, pos + info);
      pos += info;
      return Buffer.from(out);
    }
    if (major === 3) {
      const out = buf.subarray(pos, pos + info);
      pos += info;
      return out.toString('utf8');
    }
    if (major === 5) {
      const map = {};
      for (let i = 0; i < info; i++) {
        const key = readItem();
        map[key] = readItem();
      }
      return map;
    }
    throw new Error(`unsupported CBOR major type ${major}`);
  }
  const value = readItem();
  if (pos !== buf.length) throw new Error('trailing CBOR bytes');
  return value;
}

// --- Assertion verification ----------------------------------------------------

/**
 * Verify a WebAuthn assertion. All inputs are base64url fields from
 * navigator.credentials.get(). Throws with a reason on any mismatch.
 * Returns the stored sign count hint so the caller can persist a new one.
 */
export function verifyAssertion({
  clientDataJSON,
  authenticatorData,
  signature,
  keyObject,
  alg,
  expectedChallenge,
  expectedOrigin,
  expectedRpId,
}) {
  const clientData = JSON.parse(b64urlToBuffer(clientDataJSON).toString('utf8'));
  if (clientData.type !== 'webauthn.get') throw new Error('wrong ceremony type');
  if (String(clientData.challenge) !== expectedChallenge) throw new Error('challenge mismatch');
  const origin = String(clientData.origin || '');
  if (expectedOrigin && origin !== expectedOrigin) throw new Error('origin mismatch');

  const authData = b64urlToBuffer(authenticatorData);
  if (authData.length < 37) throw new Error('authenticator data too short');
  const rpIdHash = crypto.createHash('sha256').update(expectedRpId).digest();
  if (!rpIdHash.equals(authData.subarray(0, 32))) throw new Error('rpId mismatch');
  const flags = authData[32];
  if (!(flags & 0x01)) throw new Error('user presence flag not set');
  const signCount = authData.readUInt32BE(33);

  const signatureBase = Buffer.concat([
    authData,
    crypto.createHash('sha256').update(b64urlToBuffer(clientDataJSON)).digest(),
  ]);

  let ok = false;
  if (alg === 'Ed25519') {
    ok = crypto.verify(null, signatureBase, keyObject, b64urlToBuffer(signature));
  } else {
    // ES256 / RS256 both sign SHA-256 digests; ES256 signatures are DER.
    ok = crypto.verify('sha256', signatureBase, keyObject, b64urlToBuffer(signature));
  }
  if (!ok) throw new Error('signature verification failed');
  return { signCount, userVerified: Boolean(flags & 0x04) };
}

/** Host (rpId) + origin pair for a request, from the browser's Origin header. */
export function originFromRequest(req) {
  const origin = String(req.headers.origin || '');
  if (!/^https?:\/\//.test(origin)) throw new Error('missing origin header');
  const host = new URL(origin).hostname;
  return { origin, rpId: host };
}
