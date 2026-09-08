import {
  invariant,
  type CredentialVault,
  type McpCredentials,
  type RecordStore,
} from "@durable-harness/core";

interface Envelope {
  version: 1;
  iv: number[];
  ciphertext: number[];
}

/** Only the host can access this store. The encryption key is a Worker secret. */
export class EncryptedSecrets {
  private readonly key: Promise<CryptoKey>;
  constructor(
    private readonly store: RecordStore,
    base64Key: string,
  ) {
    const bytes = Uint8Array.from(atob(base64Key), (character) => character.charCodeAt(0));
    invariant(
      bytes.length === 32,
      "INVALID_INPUT",
      "The credential encryption secret must contain a base64-encoded 32-byte key.",
    );
    this.key = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async get<T>(id: string): Promise<T | undefined> {
    const envelope = this.store.get<Envelope>("protected_credentials", id);
    if (!envelope) return undefined;
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(envelope.iv),
        additionalData: new TextEncoder().encode(id),
      },
      await this.key,
      new Uint8Array(envelope.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }
  async put(id: string, value: unknown): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
      await this.key,
      new TextEncoder().encode(JSON.stringify(value)),
    );
    this.store.put("protected_credentials", id, {
      version: 1,
      iv: [...iv],
      ciphertext: [...new Uint8Array(ciphertext)],
    } satisfies Envelope);
  }
  async delete(id: string): Promise<void> {
    this.store.delete("protected_credentials", id);
  }
}

export class EncryptedCredentialVault implements CredentialVault {
  constructor(private readonly secrets: EncryptedSecrets) {}
  get(id: string): Promise<McpCredentials | undefined> {
    return this.secrets.get(`mcp:${id}`);
  }
  put(id: string, value: McpCredentials): Promise<void> {
    return this.secrets.put(`mcp:${id}`, value);
  }
  delete(id: string): Promise<void> {
    return this.secrets.delete(`mcp:${id}`);
  }
}
