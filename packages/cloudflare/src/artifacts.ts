import { HarnessFault, type ArtifactBackend } from "@durable-harness/core";

/** Blob writes finish before the workspace stores their durable references. */
export class R2Artifacts implements ArtifactBackend {
  constructor(private readonly bucket: R2Bucket) {}
  async put(key: string, bytes: Uint8Array): Promise<void> { await this.bucket.put(key, bytes); }
  async get(key: string, offset: number, length: number): Promise<Uint8Array> {
    if (!length) return new Uint8Array();
    const object = await this.bucket.get(key, { range: { offset, length } });
    if (!object) throw new HarnessFault("NOT_FOUND", "The artifact blob is unavailable. Its metadata has been retained for recovery.");
    return new Uint8Array(await object.arrayBuffer());
  }
}
