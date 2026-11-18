/**
 * Loads a Node built-in (fs, path, url) without bundlers pulling it into
 * browser builds. `Function("return require")()` alone does not work in a
 * CommonJS or ESM module, where `require` is not a global, so local mode used
 * to find no files outside a REPL. Order: process.getBuiltinModule (Node 20.16+
 * / 22.3+, also inside ESM bundles), the module's own require (CommonJS), the
 * global require (REPL, some test runners). Null in browsers.
 */
export function loadNodeBuiltin<T>(name: string): T | null {
  if (typeof process === "undefined" || !process.versions?.node) return null;
  const getBuiltinModule = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltinModule === "function") {
    try {
      const loaded = getBuiltinModule(name);
      if (loaded) return loaded as T;
    } catch {
      // fall through
    }
  }
  try {
    if (typeof require === "function") {
      const moduleRequire = require;
      return moduleRequire(name) as T;
    }
  } catch {
    // fall through
  }
  try {
    return (Function("return require")() as (id: string) => unknown)(name) as T;
  } catch {
    return null;
  }
}
