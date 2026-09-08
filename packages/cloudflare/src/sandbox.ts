import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { asFault, type CellExecutor } from "@durable-harness/core";

/** No credentials or outbound network are available inside generated code. */
export class CloudflareCellExecutor implements CellExecutor {
  private readonly executor: DynamicWorkerExecutor;
  constructor(loader: WorkerLoader, timeout = 30_000) {
    this.executor = new DynamicWorkerExecutor({ loader, timeout, globalOutbound: null });
  }
  async execute(code: string, invoke: (name: string, input: unknown) => Promise<unknown>): Promise<unknown> {
    let hostError: unknown;
    const result = await this.executor.execute(code, [{ name: "host", fns: { invoke: async (...args: unknown[]) => {
      try { return await invoke(String(args[0]), args[1]); }
      catch (error) { hostError = error; throw new Error(`[${asFault(error).code}] ${asFault(error).message}`); }
    } } }]);
    if (hostError) throw hostError;
    if (result.error) throw asFault(new Error(result.error));
    return result.result;
  }
}
