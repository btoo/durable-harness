import {
  compileCell,
  decodeGraph,
  encodeGraph,
  invariant,
  type CapabilityExecutor,
  type CapabilityProgram,
} from "@durable-harness/core";
import { CloudflareCellExecutor } from "./sandbox.js";

/** Installed helpers receive caller data and no host I/O or publishing credentials. */
export class PureCapabilityExecutor implements CapabilityExecutor {
  private readonly executor: CloudflareCellExecutor;
  constructor(loader: WorkerLoader) {
    this.executor = new CloudflareCellExecutor(loader, 1000);
  }
  async run(program: CapabilityProgram, args: unknown[]): Promise<unknown> {
    let inputName = "capabilityArguments";
    while (Object.values(program.modules).some((module) => module.name === inputName))
      inputName += "_";
    const compiled = await compileCell(`${program.entry.name}(...${inputName});`, {
      revision: 0,
      graph: encodeGraph({ [inputName]: args }),
      functions: { [program.entry.name]: program.entry },
      modules: program.modules,
      lineage: [],
    });
    const returned = (await this.executor.execute(compiled.code, async () => {
      throw new Error(
        "Published pure helpers cannot perform host I/O. Use a separately authorized workspace tool.",
      );
    })) as { output?: ReturnType<typeof encodeGraph> };
    invariant(returned.output, "INVALID_TOOL_RESULT", "The capability returned no output.");
    return (decodeGraph(returned.output).value as { result?: unknown }).result;
  }
}
