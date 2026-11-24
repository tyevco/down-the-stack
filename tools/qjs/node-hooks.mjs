// Node resolve hook for node-run.mjs: the same module map as run.mjs's QuickJS loader.
const SHIMS = new URL("./shims/", import.meta.url);
const MOD = process.env.QJS_MOD_DIR_URL;
export async function resolve(specifier, context, next) {
  if (specifier === "herdr" || specifier === "gpui-kit" || specifier === "gpui-base") return { url: new URL(`${specifier}.js`, SHIMS).href, shortCircuit: true };
  if (specifier.startsWith("@mod/")) return { url: new URL(specifier.slice(5), MOD).href, shortCircuit: true };
  return next(specifier, context);
}
