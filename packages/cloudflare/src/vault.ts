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
    this.store.put("protected_credential_keys", id, { id });
  }
  async delete(id: string): Promise<void> {
    this.store.delete("protected_credentials", id);
    this.store.delete("protected_credential_keys", id);
  }
  keys(prefix = ""): string[] {
    return this.store
      .list<{ id: string }>("protected_credential_keys")
      .map((value) => value.id)
      .filter((id) => id.startsWith(prefix))
      .sort();
  }
}

/** The Cloudflare OAuth provider uses this encrypted subset of DurableObjectStorage. */
export function encryptedOAuthStorage(secrets: EncryptedSecrets): DurableObjectStorage {
  const storage = {
    async get(key: string | string[]) {
      if (Array.isArray(key)) {
        const entries = await Promise.all(
          key.map(async (id) => [id, await secrets.get(id)] as const),
        );
        return new Map(entries.filter(([, value]) => value !== undefined));
      }
      return secrets.get(key);
    },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === "string") await secrets.put(key, value);
      else for (const [id, entry] of Object.entries(key)) await secrets.put(id, entry);
    },
    async delete(key: string | string[]) {
      const keys = Array.isArray(key) ? key : [key];
      let deleted = 0;
      for (const id of keys) {
        if ((await secrets.get(id)) !== undefined) deleted++;
        await secrets.delete(id);
      }
      return Array.isArray(key) ? deleted : deleted > 0;
    },
    async list(options: DurableObjectListOptions = {}) {
      let keys = secrets
        .keys(options.prefix)
        .filter(
          (id) =>
            (!options.start || id >= options.start) &&
            (!options.startAfter || id > options.startAfter) &&
            (!options.end || id < options.end),
        );
      if (options.reverse) keys.reverse();
      if (options.limit) keys = keys.slice(0, options.limit);
      return new Map(
        await Promise.all(keys.map(async (id) => [id, await secrets.get(id)] as const)),
      );
    },
  };
  return storage as unknown as DurableObjectStorage;
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
