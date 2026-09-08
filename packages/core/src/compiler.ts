import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { transform } from "sucrase";
import { HarnessFault, invariant } from "./errors.js";
import type { FunctionModule, WorkspaceSnapshot } from "./types.js";
import { cellRuntimeSources } from "./runtime-source.js";

const runtimeNames = new Set(["tools", "runtime", "history", "memory", "artifacts", "console"]);
const reservedNames = new Set([
  "host",
  "globalThis",
  "self",
  "Function",
  "eval",
  "fetch",
  "WebSocket",
  "crypto",
  "performance",
  "setTimeout",
  "setInterval",
]);
const globals = new Set([
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Math",
  "JSON",
  "Map",
  "Set",
  "Date",
  "Uint8Array",
  "TextEncoder",
  "TextDecoder",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "RegExp",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "undefined",
  "NaN",
  "Infinity",
]);

export async function contentHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

/** Revalidate pinned source under the current language policy, including published pure helpers. */
export function validateModuleSource(module: FunctionModule, allowHostCalls = true): void {
  invariant(
    !reservedNames.has(module.name) && !module.name.startsWith("__dh"),
    "INVALID_CELL",
    "This module name is reserved by the runtime.",
  );
  const ast = parse(module.source, { sourceType: "module" });
  traverse(ast, {
    ImportExpression() {
      throw new HarnessFault(
        "INVALID_CELL",
        "Retained modules cannot import ambient capabilities.",
      );
    },
    ThisExpression() {
      throw new HarnessFault(
        "UNSUPPORTED_CAPTURE",
        "Retained modules require explicit arguments instead of this.",
      );
    },
    ReferencedIdentifier(path) {
      const name = path.node.name;
      invariant(
        !name.startsWith("__dh") &&
          (path.scope.hasBinding(name) ||
            globals.has(name) ||
            Object.hasOwn(module.dependencies, name) ||
            (allowHostCalls && runtimeNames.has(name)) ||
            name === "console"),
        "UNSUPPORTED_CAPTURE",
        `Module ${module.name} refers to ${name}, outside its declared pure dependencies.`,
      );
    },
  });
}

function transpile(source: string): string {
  try {
    return transform(source, {
      transforms: ["typescript"],
      disableESTransforms: true,
      filePath: "cell.ts",
    }).code;
  } catch (error) {
    throw new HarnessFault("INVALID_CELL", error instanceof Error ? error.message : String(error));
  }
}

export interface CompiledCell {
  code: string;
  functions: Record<string, FunctionModule>;
  modules: Record<string, FunctionModule>;
  names: string[];
}

/** A lexical-scope-aware compiler; application data never needs a predefined schema. */
export async function compileCell(
  source: string,
  starting: WorkspaceSnapshot,
): Promise<CompiledCell> {
  let ast: t.File;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: ["typescript"],
      allowAwaitOutsideFunction: true,
    });
  } catch (error) {
    throw new HarnessFault("INVALID_CELL", error instanceof Error ? error.message : String(error));
  }
  const declared = new Set<string>();
  const helpers = new Map<string, { node: t.Node; source: string }>();
  const dataNames = new Set(Object.keys(starting.graph.roots));
  for (const statement of ast.program.body) {
    invariant(
      !t.isImportDeclaration(statement) &&
        !t.isExportDeclaration(statement) &&
        !t.isReturnStatement(statement),
      "INVALID_CELL",
      "Cells do not import, export, or return at top level. Declare bindings and use tools.call() for capabilities.",
    );
    invariant(
      !t.isClassDeclaration(statement) && !t.isTSEnumDeclaration(statement),
      "UNSUPPORTED_VALUE",
      "Persist plain data or a helper function instead of a class or enum.",
    );
    if (t.isVariableDeclaration(statement)) {
      for (const declaration of statement.declarations) {
        for (const name of Object.keys(t.getBindingIdentifiers(declaration.id))) {
          declared.add(name);
          dataNames.add(name);
        }
        if (
          t.isIdentifier(declaration.id) &&
          declaration.init &&
          (t.isArrowFunctionExpression(declaration.init) ||
            t.isFunctionExpression(declaration.init))
        ) {
          helpers.set(declaration.id.name, {
            node: declaration.init,
            source: `const ${source.slice(declaration.start!, declaration.end!)};`,
          });
          dataNames.delete(declaration.id.name);
        }
      }
    } else if (t.isFunctionDeclaration(statement) && statement.id) {
      declared.add(statement.id.name);
      helpers.set(statement.id.name, {
        node: statement,
        source: source.slice(statement.start!, statement.end!),
      });
      dataNames.delete(statement.id.name);
    }
  }
  for (const name of declared)
    invariant(
      !name.startsWith("__dh") &&
        !runtimeNames.has(name) &&
        !globals.has(name) &&
        !reservedNames.has(name),
      "INVALID_CELL",
      `The binding name ${name} is reserved by the runtime.`,
    );
  const functionNames = new Set([...Object.keys(starting.functions), ...helpers.keys()]);
  for (const name of functionNames)
    if (!declared.has(name) || helpers.has(name)) dataNames.delete(name);
  const dependencies = new Map([...helpers.keys()].map((name) => [name, new Set<string>()]));
  traverse(ast, {
    ReferencedIdentifier(path) {
      if (path.findParent((parent) => parent.isTSType())) return;
      const name = path.node.name;
      invariant(
        !name.startsWith("__dh") &&
          (path.scope.hasBinding(name) ||
            globals.has(name) ||
            runtimeNames.has(name) ||
            dataNames.has(name) ||
            functionNames.has(name)),
        "INVALID_CELL",
        `${name} is not in the durable namespace. Use the namespace index and declared cell capabilities.`,
      );
      if (
        [
          "fetch",
          "eval",
          "Function",
          "WebSocket",
          "globalThis",
          "self",
          "crypto",
          "performance",
          "setTimeout",
          "setInterval",
        ].includes(name)
      )
        throw new HarnessFault(
          "INVALID_CELL",
          `${name} is not a cell capability. Use journaled tools.call(), runtime.now(), or runtime.uuid().`,
        );
      for (const [helperName, helper] of helpers) {
        if (path.node.start! < helper.node.start! || path.node.end! > helper.node.end!) continue;
        const binding = path.scope.getBinding(name);
        const local =
          binding &&
          binding.path.node.start! >= helper.node.start! &&
          binding.path.node.end! <= helper.node.end!;
        if (local || name === helperName || globals.has(name) || runtimeNames.has(name)) continue;
        if (functionNames.has(name)) dependencies.get(helperName)!.add(name);
        else
          throw new HarnessFault(
            "UNSUPPORTED_CAPTURE",
            `Helper ${helperName} captures ${name}. Pass that value as an argument; retained functions cannot capture mutable workspace data.`,
          );
      }
    },
    ImportExpression() {
      throw new HarnessFault(
        "INVALID_CELL",
        "Dynamic imports are not cell capabilities. Discover an installed tool or declare a supported helper module.",
      );
    },
    ThisExpression() {
      throw new HarnessFault(
        "INVALID_CELL",
        "Cells and retained helpers cannot capture this. Pass explicit data and use declared capabilities.",
      );
    },
    MemberExpression(path) {
      const node = path.node;
      const property =
        t.isIdentifier(node.property) && !node.computed
          ? node.property.name
          : t.isStringLiteral(node.property)
            ? node.property.value
            : "";
      if (
        t.isIdentifier(node.object) &&
        ((node.object.name === "Date" && property === "now") ||
          (node.object.name === "Math" && property === "random"))
      )
        throw new HarnessFault(
          "INVALID_CELL",
          "Use runtime.now() or runtime.random() so replay preserves nondeterministic values.",
        );
    },
    NewExpression(path) {
      if (t.isIdentifier(path.node.callee, { name: "Date" }) && !path.node.arguments.length)
        throw new HarnessFault(
          "INVALID_CELL",
          "Use new Date(await runtime.now()) to preserve time across replay.",
        );
    },
  });
  const modules = { ...starting.functions };
  const visiting = new Set<string>();
  const built = new Set<string>();
  const build = async (name: string): Promise<void> => {
    if (built.has(name) || !helpers.has(name)) return;
    invariant(
      !visiting.has(name),
      "UNSUPPORTED_CAPTURE",
      "Mutually recursive retained helpers are unsupported. Combine them in one helper module.",
    );
    visiting.add(name);
    const refs: Record<string, string> = {};
    for (const dependency of dependencies.get(name) ?? []) {
      await build(dependency);
      refs[dependency] = modules[dependency]!.version;
    }
    const js = transpile(helpers.get(name)!.source);
    modules[name] = {
      name,
      source: js,
      dependencies: refs,
      version: await contentHash(JSON.stringify([js, refs])),
    };
    built.add(name);
    visiting.delete(name);
  };
  for (const name of helpers.keys()) await build(name);
  for (const name of declared) if (!helpers.has(name)) delete modules[name];
  const archive = {
    ...starting.modules,
    ...Object.fromEntries(
      Object.values(starting.functions).map((module) => [module.version, module]),
    ),
    ...Object.fromEntries(Object.values(modules).map((module) => [module.version, module])),
  };
  const factories = Object.values(archive)
    .map((module) => {
      validateModuleSource(module);
      const dependencies = Object.entries(module.dependencies)
        .map(([name, version]) => {
          invariant(
            archive[version],
            "NOT_FOUND",
            `The retained dependency ${name}@${version.slice(0, 8)} is missing.`,
          );
          return `const ${name} = __dhModule(${JSON.stringify(version)});`;
        })
        .join("\n");
      return `${JSON.stringify(module.version)}: () => {${dependencies}\n${module.source}\nreturn ${module.name};}`;
    })
    .join(",\n");
  const definitions = Object.values(modules)
    .filter((module) => !declared.has(module.name))
    .map((module) => `const ${module.name} = __dhModule(${JSON.stringify(module.version)});`);
  const prelude = [...dataNames]
    .filter((name) => !declared.has(name))
    .map((name) => `let ${name} = __dhRoots[${JSON.stringify(name)}];`)
    .join("\n");
  const names = [...dataNames].sort();
  const last = ast.program.body.at(-1);
  const hasResult = t.isExpressionStatement(last);
  const executed = hasResult
    ? source.slice(0, last.start!) +
      `const __dhValue = (${source.slice(last.expression.start!, last.expression.end!)});`
    : source + "\nconst __dhValue = undefined;";
  const code = `async () => {
    (${cellRuntimeSources.hardenCellGlobals})();
    const __dhDecode = ${cellRuntimeSources.decodeGraph};
    const __dhEncode = ${cellRuntimeSources.encodeGraph};
    const __dhRoots = __dhDecode(${JSON.stringify(starting.graph)});
    const __dhLogs = [];
    let __dhOmittedLogs = 0;
    const console = Object.fromEntries(["log", "info", "warn", "error"].map(level => [level, (...values) => {
      if (__dhLogs.length >= 20) { __dhOmittedLogs++; return; }
      __dhLogs.push({level, values: __dhDecode(__dhEncode({value:values.map(value => typeof value === "function" ? "[Function " + value.name + "]" : value instanceof Error ? String(value) : value)})).value});
    }]));
    const tools = { call: (name, input) => host.invoke(name, input), search: (query) => host.invoke("@tools.search", {query}), describe: (name) => host.invoke("@tools.describe", {name}) };
    const runtime = { now: () => host.invoke("@runtime.now", {}), uuid: () => host.invoke("@runtime.uuid", {}), random: () => host.invoke("@runtime.random", {}), progress: (text) => host.invoke("@runtime.progress", {text}) };
    const history = { search: (query) => host.invoke("@history.search", {query}), read: (id) => host.invoke("@history.read", {id}), around: (id) => host.invoke("@history.around", {id}) };
    const memory = { read: (id) => host.invoke("@memory.read", {id}), write: (input) => host.invoke("@memory.write", input) };
    const artifacts = { read: (id, options = {}) => host.invoke("@artifacts.read", {id, ...options}), write: (input) => host.invoke("@artifacts.write", input) };
    const __dhModuleCache = new Map();
    const __dhFactories = {${factories}};
    const __dhModule = version => { if (!__dhModuleCache.has(version)) __dhModuleCache.set(version, __dhFactories[version]()); return __dhModuleCache.get(version); };
    ${prelude}\n${definitions.join("\n")}\n${transpile(executed)}
    return { graph: __dhEncode({${names.map((name) => `${JSON.stringify(name)}:${name}`).join(",")}}), output: __dhEncode({value: { ...(__dhValue !== undefined ? {result:__dhValue} : {}), ...(__dhLogs.length ? {logs:__dhLogs} : {}), ...(__dhOmittedLogs ? {omittedLogs:__dhOmittedLogs} : {})}}) };
  }`;
  return { code, functions: modules, modules: archive, names };
}

/** Runs inside the isolated code worker; aliases cannot recover ambient clocks or code constructors. */
function hardenCellGlobals() {
  if (Object.hasOwn(globalThis, "__dhHardened")) return;
  const unavailable = () => {
    throw new Error(
      "Use journaled runtime.now(), runtime.random(), and explicit helper modules; ambient time and dynamic code generation are unavailable.",
    );
  };
  const nativeDate = globalThis.Date;
  Object.defineProperty(nativeDate, "now", {
    value: unavailable,
    writable: false,
    configurable: false,
  });
  const date = new Proxy(nativeDate, {
    apply: unavailable,
    construct(target, args, newTarget) {
      if (!args.length) unavailable();
      return Reflect.construct(target, args, newTarget);
    },
  });
  Object.defineProperty(nativeDate.prototype, "constructor", {
    value: date,
    writable: false,
    configurable: false,
  });
  Object.freeze(nativeDate.prototype);
  Object.freeze(nativeDate);
  Object.defineProperty(globalThis, "Date", { value: date, writable: false, configurable: false });
  Object.defineProperty(Math, "random", {
    value: unavailable,
    writable: false,
    configurable: false,
  });
  Object.freeze(Math);
  for (const prototype of [
    Function.prototype,
    Object.getPrototypeOf(async () => {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ]) {
    Object.defineProperty(prototype, "constructor", {
      value: unavailable,
      writable: false,
      configurable: false,
    });
    Object.freeze(prototype);
  }
  Object.defineProperty(globalThis, "__dhHardened", {
    value: true,
    writable: false,
    configurable: false,
  });
}
