export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view: SubtleCrypto takes no SharedArrayBuffer.
  const input = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
