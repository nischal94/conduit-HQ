/**
 * Secrets-at-rest encryption (spec §9.2): AES-256-GCM under a 32-byte
 * master key. Uses WebCrypto exclusively — the same code path runs in
 * Node 20+ and Cloudflare Workers (spec §13 parity), never node:crypto.
 *
 * Sealed format: `v1.<base64 iv>.<base64 ciphertext+tag>`. GCM
 * authenticates, so tampering with either part fails decryption loudly.
 */

const ALGORITHM = "AES-GCM";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT_VERSION = "v1";

export class SecretBox {
  readonly #key: CryptoKey;

  private constructor(key: CryptoKey) {
    this.#key = key;
  }

  static async fromKeyBytes(bytes: Uint8Array<ArrayBuffer>): Promise<SecretBox> {
    if (bytes.length !== KEY_BYTES) {
      throw new Error(
        `[SecretBox] Failed to initialize: master key must be ${KEY_BYTES} bytes. Context: { length: ${bytes.length} }`,
      );
    }
    const key = await crypto.subtle.importKey("raw", bytes, ALGORITHM, false, [
      "encrypt",
      "decrypt",
    ]);
    return new SecretBox(key);
  }

  static generateKeyBytes(): Uint8Array<ArrayBuffer> {
    return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  }

  async seal(plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      { name: ALGORITHM, iv },
      this.#key,
      new TextEncoder().encode(plaintext),
    );
    return `${FORMAT_VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
  }

  async open(sealed: string): Promise<string> {
    const [version, iv, ciphertext] = sealed.split(".");
    if (version !== FORMAT_VERSION || iv === undefined || ciphertext === undefined) {
      throw new Error(
        "[SecretBox] Failed to decrypt: sealed value is not in the expected format. Context: { expected: v1.<iv>.<ciphertext> }",
      );
    }
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: ALGORITHM, iv: fromBase64(iv) },
        this.#key,
        fromBase64(ciphertext),
      );
    } catch {
      // WebCrypto's OperationError carries no detail by design; say why.
      throw new Error(
        "[SecretBox] Failed to decrypt: wrong master key or tampered ciphertext. Context: { format: v1 }",
      );
    }
    return new TextDecoder().decode(plaintext);
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
