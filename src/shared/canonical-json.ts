/**
 * Deterministic (canonical) JSON serialisation — the subset of RFC 8785 (JCS) needed for
 * hashing and signing AnterisLab records.
 *
 * Rules implemented:
 *  - object keys sorted by UTF-16 code unit (JS default `Array.prototype.sort`)
 *  - no insignificant whitespace
 *  - `undefined` members are dropped; `null` is preserved
 *  - only JSON-safe primitives are allowed: string, boolean, null, integer number, array, object
 *  - non-integer numbers are REJECTED (IEEE-754 float formatting differs across engines; every
 *    AnterisLab canonical record is built from integers/strings only, so this keeps hashes
 *    byte-stable across Node, Deno, browsers and other independent implementations)
 *
 * Anything that cannot be canonically serialised throws: a record we cannot hash deterministically
 * is a record we must not sign or chain.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`canonicalize: non-finite number (${String(value)})`);
      }
      if (!Number.isInteger(value)) {
        throw new CanonicalJsonError(
          `canonicalize: non-integer number ${value} is not supported (use integers or strings)`,
        );
      }
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(`canonicalize: number ${value} exceeds safe integer range`);
      }
      return JSON.stringify(value);
    }
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item === undefined ? null : item)).join(',')}]`;
      }
      const source = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(source).sort()) {
        const member = source[key];
        if (member === undefined) continue;
        if (typeof member === 'function' || typeof member === 'symbol') {
          throw new CanonicalJsonError(`canonicalize: unsupported value for key "${key}"`);
        }
        parts.push(`${JSON.stringify(key)}:${canonicalize(member)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`canonicalize: unsupported type "${typeof value}"`);
  }
}
