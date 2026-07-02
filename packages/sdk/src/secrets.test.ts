import { describe, expect, it } from "vitest";
import { SecretBox } from "./secrets.js";

describe("SecretBox", () => {
  it("round-trips a secret", async () => {
    const box = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
    const sealed = await box.seal("sk-live-abc123");
    expect(await box.open(sealed)).toBe("sk-live-abc123");
  });

  it("produces different ciphertexts for the same plaintext (fresh IV per seal)", async () => {
    const box = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
    expect(await box.seal("same")).not.toBe(await box.seal("same"));
  });

  it("never includes the plaintext in the sealed value", async () => {
    const box = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
    const sealed = await box.seal("hunter2-hunter2-hunter2");
    expect(sealed).not.toContain("hunter2");
  });

  it("refuses to decrypt with the wrong master key", async () => {
    const alice = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
    const mallory = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
    const sealed = await alice.seal("secret");
    await expect(mallory.open(sealed)).rejects.toThrow(/wrong master key or tampered/);
  });

  it("refuses tampered ciphertext (GCM authentication)", async () => {
    const box = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
    const sealed = await box.seal("secret");
    const parts = sealed.split(".");
    const flipped = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -4)}AAA=`;
    await expect(box.open(flipped)).rejects.toThrow(/wrong master key or tampered/);
  });

  it("rejects malformed keys and sealed values", async () => {
    await expect(SecretBox.fromKeyBytes(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
    const box = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
    await expect(box.open("not-a-sealed-value")).rejects.toThrow(/expected format/);
  });
});
