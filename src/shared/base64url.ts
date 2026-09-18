/**
 * Portable base64url / base64 / UTF-8 codecs.
 *
 * Deliberately free of `node:*` imports so the exact same module can be bundled into the
 * browser/edge SDK (@anterislab/guard) and used on the server. This mirrors the JWS
 * requirement (RFC 7515 §2): base64url, no padding, `-` and `_` instead of `+` and `/`.
 */

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64URL_LOOKUP: Int16Array = buildLookup(B64URL_ALPHABET);
const B64_STD_LOOKUP: Int16Array = buildLookup(B64_STD_ALPHABET);

function buildLookup(alphabet: string): Int16Array {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) {
    table[alphabet.charCodeAt(i)] = i;
  }
  return table;
}

export function utf8Encode(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

export function utf8Decode(input: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(input);
}

/** Encode bytes as unpadded base64url (JWS form). */
export function bytesToB64u(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1: number | undefined = bytes[i + 1];
    const b2: number | undefined = bytes[i + 2];
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 === undefined) break;
    out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 === undefined) break;
    out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function utf8ToB64u(input: string): string {
  return bytesToB64u(utf8Encode(input));
}

export interface DecodeOptions {
  /** Reject anything that is not strictly base64url: no `+`, `/`, `=` padding or whitespace. */
  strict?: boolean;
  /** Maximum accepted input length, a cheap guard against absurd inputs. */
  maxLength?: number;
}

function decodeWith(bytes: string, lookup: Int16Array, opts: DecodeOptions, alphabetName: string): Uint8Array {
  const strict = opts.strict ?? true;
  if (opts.maxLength !== undefined && bytes.length > opts.maxLength) {
    throw new Error(`base64: input exceeds maxLength=${opts.maxLength}`);
  }
  let input = bytes;
  if (!strict) {
    input = input.replace(/[\s=]/g, '');
  } else if (input.includes('=')) {
    throw new Error('base64url: unexpected padding character "="');
  }
  const out = new Uint8Array(Math.floor((input.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const value = code < 128 ? (lookup[code] as number) : -1;
    if (value < 0) {
      throw new Error(`base64${alphabetName}: invalid character at index ${i}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}

/** Decode strict unpadded base64url (JWS). Throws on any non-base64url character. */
export function b64uToBytes(input: string, opts: DecodeOptions = {}): Uint8Array {
  if (input.length > 0 && input.length % 4 === 1) {
    throw new Error('base64url: invalid length (cannot be 1 mod 4)');
  }
  return decodeWith(input, B64URL_LOOKUP, opts, 'url');
}

/** Decode standard base64 (PEM bodies, `+`/`/`, padding optional). */
export function b64ToBytes(input: string, opts: DecodeOptions = {}): Uint8Array {
  return decodeWith(input, B64_STD_LOOKUP, { ...opts, strict: opts.strict ?? false }, '');
}

export function b64uToString(input: string, opts: DecodeOptions = {}): string {
  return utf8Decode(b64uToBytes(input, opts));
}

/** Constant-time-ish comparison of two byte arrays (length is leaked, content is not). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('hex: invalid input');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return out;
}
