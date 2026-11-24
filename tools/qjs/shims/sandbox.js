// herdr's script sandbox, copied verbatim from
// herdr-app/vendor/gpui-kit/crates/shell/src/engine/quickjs/sandbox.rs
//   WITHHOLD_DYNAMIC_CODE (sandbox.rs:166-194), FREEZE_BUILTINS (sandbox.rs:200-212),
//   ABSENT_GLOBALS (sandbox.rs:226-238, installed as throwing stubs by install_absent_globals).
// Evaluated as global code in the QuickJS context before any mod module, as install_globals does
// last (sandbox.rs:1-15). Release herdr is not in --dev mode, so both halves are in force.
(() => {
  const hint = "the shell sandbox withholds dynamic code; run the host with --dev to allow it";
  const deny = (label) => function () {
    throw new TypeError(`${label} is disabled: ${hint}`);
  };

  const replaceConstructor = (holder, value) => {
    Object.defineProperty(Object.getPrototypeOf(holder), "constructor", {
      value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  };

  const blocked = deny("the Function constructor");
  blocked.prototype = Function.prototype;

  replaceConstructor(function () {}, blocked);
  replaceConstructor(async function () {}, deny("the AsyncFunction constructor"));
  replaceConstructor(function* () {}, deny("the GeneratorFunction constructor"));
  replaceConstructor(async function* () {}, deny("the AsyncGeneratorFunction constructor"));

  globalThis.Function = blocked;
  delete globalThis.eval;
})();

(() => {
  for (const name of ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "require"]) {
    if (name in globalThis) continue;
    const message = `\`${name}\` is not available in the shell`;
    globalThis[name] = function () { throw new TypeError(message); };
  }
})();

(() => {
  for (const proto of [
    Object.prototype,
    Array.prototype,
    Function.prototype,
    String.prototype,
    Number.prototype,
  ]) {
    Object.freeze(proto);
  }
})();
