import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { decodeGraph, emptyGraph } from "@durable-harness/core";

// vm is only a test runner for our fixed fixture; production isolation uses Workers.
for (const minify of [false, true])
  it(`executes cells from a production bundle with keepNames and minify=${minify}`, async () => {
    await mkdir(resolve(".wrangler"), { recursive: true });
    const directory = await mkdtemp(resolve(".wrangler/compiled-runtime-"));
    try {
      const bundle = await build({
        entryPoints: ["packages/core/src/compiler.ts"],
        bundle: true,
        platform: "node",
        format: "cjs",
        mainFields: ["module", "main"],
        keepNames: true,
        minify,
        write: false,
      });
      const file = resolve(directory, "compiler.cjs");
      await writeFile(file, bundle.outputFiles[0]!.text);
      const compiler = createRequire(import.meta.url)(
        file,
      ) as typeof import("../../packages/core/src/compiler.js");
      const compiled = await compiler.compileCell(
        "const retained = {value:21}; function twice(value) {return value*2;} const answer=twice(retained.value);",
        { revision: 0, graph: emptyGraph(), functions: {}, lineage: [] },
      );
      const result = await new Script(`(${compiled.code})()`).runInNewContext(
        {},
        { timeout: 1000 },
      );
      expect(decodeGraph(result.graph)).toEqual({ retained: { value: 21 }, answer: 42 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
