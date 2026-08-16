import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

/**
 * Password hashing via Node's built-in scrypt. Storage format:
 *
 *   scrypt:<salt-hex>:<hash-hex>
 *
 * scrypt with Node defaults (N=16384, r=8, p=1) is OWASP-recommended and
 * gives us bcrypt-equivalent resistance to GPU brute-force without adding
 * a dependency.
 */
const SCHEME = "scrypt";
const SALT_BYTES = 16;
const HASH_BYTES = 64;

export function hashPassword(plaintext: string): string {
  if (!plaintext) throw new Error("hashPassword: empty plaintext");
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plaintext, salt, HASH_BYTES);
  return `${SCHEME}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Constant-time password verification. Returns false on any malformed
 * stored value (wrong scheme, missing parts, length mismatch) — never
 * throws on a bad password.
 */
export function verifyPassword(
  plaintext: string,
  stored: string | null | undefined,
): boolean {
  if (!plaintext || !stored) return false;
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  const [scheme, saltHex, hashHex] = parts;
  if (scheme !== SCHEME) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length !== SALT_BYTES || expected.length !== HASH_BYTES) return false;
  const actual = scryptSync(plaintext, salt, HASH_BYTES);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
