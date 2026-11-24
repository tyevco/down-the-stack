// Argument grammar for element methods, mirroring herdr's gpui-shell (style.rs apply_param,
// value.rs Bridged) so the mock throws where herdr throws, with the same wording.
//
// Thrown errors carry `code` so tests and the check report can classify them.

/** Create an Error (TypeError by default) tagged with a mock error code. */
export function mockError(code, message, Ctor = TypeError) {
  const e = new Ctor(message);
  e.code = code;
  return e;
}

/** Bridged::describe() */
function describe(v) {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "boolean") return `boolean (${v})`;
  if (typeof v === "number") return `number (${v})`;
  if (typeof v === "string") return `string ("${v}")`;
  return typeof v;
}

/**
 * The value bridge: only null/undefined/boolean/number/string (and functions, for handlers)
 * cross into herdr. Objects (a Background, an array, a plain object) throw.
 */
export function checkBridgeable(v, method, { allowFunction = true } = {}) {
  const t = typeof v;
  if (v === null || v === undefined || t === "boolean" || t === "number" || t === "string") return;
  if (t === "function") {
    if (allowFunction) return;
    throw mockError("bad-argument", `\`${method}\` does not take a function`);
  }
  throw mockError("bad-argument", `${method}: unsupported argument type; expected null, boolean, number, string or function`);
}

const NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Parses a length; returns { kind: "px"|"rem"|"pct"|"auto", value }. Throws like herdr. */
export function parseLength(v, method) {
  if (typeof v === "string") {
    const text = v.trim();
    if (text === "auto") return { kind: "auto", value: null };
    const unit = text.endsWith("%") ? "%" : text.endsWith("rem") ? "rem" : text.endsWith("px") ? "px" : null;
    if (unit) {
      const num = text.slice(0, -unit.length).trim();
      if (!NUM_RE.test(num)) throw mockError("bad-length", `\`${method}\` could not read a number in the length "${text}"`);
      return { kind: unit === "%" ? "pct" : unit, value: Number(num) };
    }
    throw mockError("bad-length", `\`${method}\` expects a length: a number of pixels, or a string like "50%", "12px", "1rem" or "auto"; got "${text}"`);
  }
  if (typeof v !== "number") throw mockError("bad-length", `\`${method}\`: expected a number, got ${describe(v)}`);
  return { kind: "px", value: v };
}

/**
 * Validates one parametric style call. `type` is the allowlist grammar string.
 * Returns a list of non-fatal problems (strings) such as NaN, which herdr lets through.
 */
export function checkParamStyle(name, type, args) {
  if (args.length === 0 || args[0] === undefined) {
    throw mockError("bad-argument", `\`${name}\` expects at least 1 argument(s), got 0`);
  }
  const v = args[0];
  if (typeof v === "function") throw mockError("bad-argument", `\`${name}\` does not take a function`);
  checkBridgeable(v, name, { allowFunction: false });
  const soft = [];
  const nanCheck = (n) => {
    if (typeof n === "number" && !Number.isFinite(n)) soft.push(`${name}(${n}): a non-finite number slips through herdr unchecked and breaks layout; guard the arithmetic`);
  };
  switch (true) {
    case name === "line_height": {
      if (typeof v === "number") { nanCheck(v); break; }
      const l = parseLength(v, name);
      if (l.kind === "auto") throw mockError("bad-length", `\`${name}\` cannot be "auto"; it expects a definite length such as 12 or "50%"`);
      break;
    }
    case name === "font_weight": {
      if (typeof v !== "number") throw mockError("bad-argument", `\`${name}\`: expected a number, got ${describe(v)}`);
      if (!Number.isFinite(v) || v < 100 || v > 900) {
        throw mockError("bad-argument", `\`${name}\` expects a finite number between 100 and 900; got ${v}`);
      }
      break;
    }
    case name === "font_family": {
      if (typeof v !== "string") throw mockError("bad-argument", `\`${name}\`: expected a string, got ${describe(v)}`);
      break;
    }
    case name === "opacity": {
      if (typeof v !== "number") throw mockError("bad-argument", `\`${name}\`: expected a number, got ${describe(v)}`);
      nanCheck(v);
      if (Number.isFinite(v) && (v < 0 || v > 1)) soft.push(`opacity(${v}) is outside 0..1 (herdr does not clamp it at bind time)`);
      break;
    }
    case type.startsWith("Color"): {
      checkColor(v, name);
      break;
    }
    case type.startsWith("number"): {
      if (typeof v !== "number") throw mockError("bad-argument", `\`${name}\`: expected a number, got ${describe(v)}`);
      nanCheck(v);
      break;
    }
    case type.startsWith("AbsoluteLength"): {
      const l = parseLength(v, name);
      if (l.kind === "pct" || l.kind === "auto") {
        throw mockError("bad-length", `\`${name}\` expects an absolute length such as 8 or "0.5rem"; percentages and "auto" are not allowed here`);
      }
      nanCheck(l.value);
      break;
    }
    case type.startsWith("DefiniteLength"): {
      const l = parseLength(v, name);
      if (l.kind === "auto") throw mockError("bad-length", `\`${name}\` cannot be "auto"; it expects a definite length such as 12 or "50%"`);
      nanCheck(l.value);
      break;
    }
    case type.startsWith("Length"): {
      const l = parseLength(v, name);
      nanCheck(l.value);
      break;
    }
    default:
      break;
  }
  return soft;
}

/** Bridged::as_color(): "#rgb" | "#rrggbb" | "#rrggbbaa". Theme token names throw. */
export function checkColor(v, method = "color") {
  if (typeof v !== "string") throw mockError("bad-color", `\`${method}\`: expected a string, got ${describe(v)}`);
  if (!v.startsWith("#")) {
    throw mockError("bad-color", `\`${v}\` is not a color value; pass a color from \`cx.theme().colors\` or a #rgb, #rrggbb, or #rrggbbaa literal`);
  }
  const hex = v.slice(1);
  if (![3, 6, 8].includes(hex.length) || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw mockError("bad-color", `\`${v}\` is not a valid color literal (expected #rgb, #rrggbb or #rrggbbaa)`);
  }
}

export const MOTION_PROPS = ["opacity", "width", "height", "left", "top"];
export const EASINGS = ["linear", "ease-in", "ease-out", "ease-in-out"];

function finiteNonNegative(v, name) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw mockError("bad-motion", `${name} must be a finite non-negative number`);
  return v;
}
export function finitePositive(v, name) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw mockError("bad-argument", `${name} must be a finite positive number`);
  return v;
}
export function finiteDuration(v, name) {
  finiteNonNegative(v, name);
  if (v > 86400000) throw mockError("bad-motion", `${name} must not exceed 86400000 milliseconds`, RangeError);
  return v;
}

/** Prelude transition(): returns the normalized args. */
export function checkTransition(property, options) {
  property = String(property);
  if (!MOTION_PROPS.includes(property)) {
    throw mockError("bad-motion", `transition(property, policy) supports opacity, width, height, left or top; got ${JSON.stringify(property)}`);
  }
  const policy = typeof options === "number" ? { duration: options } : (options ?? {});
  const duration = finiteDuration(policy.duration ?? 0, "transition duration");
  const delay = finiteDuration(policy.delay ?? 0, "transition delay");
  const easing = policy.easing ?? "ease-out";
  if (!EASINGS.includes(easing)) {
    throw mockError("bad-motion", `transition easing must be linear, ease-in, ease-out or ease-in-out; got ${JSON.stringify(easing)}`);
  }
  return [property, duration, delay, easing];
}

export function checkSpring(property, options) {
  property = String(property);
  if (!MOTION_PROPS.includes(property)) {
    throw mockError("bad-motion", `spring(property, policy) supports opacity, width, height, left or top; got ${JSON.stringify(property)}`);
  }
  const p = options ?? {};
  const response = finiteDuration(p.response ?? 250, "spring response");
  const damping = finiteNonNegative(p.damping ?? 1, "spring damping");
  const epsilon = p.epsilon ?? 0.001;
  if (typeof epsilon !== "number" || !Number.isFinite(epsilon) || epsilon <= 0) throw mockError("bad-motion", "spring epsilon must be a finite positive number");
  return [property, response, damping, epsilon];
}

export function checkLoop(property, options) {
  property = String(property);
  if (!MOTION_PROPS.includes(property)) {
    throw mockError("bad-motion", `loop(property, policy) supports opacity, width, height, left or top; got ${JSON.stringify(property)}`);
  }
  const p = options ?? {};
  if (typeof p.from !== "number" || typeof p.to !== "number") {
    throw mockError("bad-motion", "loop(property, policy) needs numbers for from and to");
  }
  const period = finiteDuration(p.period ?? 1000, "loop period");
  if (period < 100) throw mockError("bad-motion", "loop period must be at least 100 milliseconds", RangeError);
  const easing = p.easing ?? "ease-in-out";
  if (!EASINGS.includes(easing)) {
    throw mockError("bad-motion", `loop easing must be linear, ease-in, ease-out or ease-in-out; got ${JSON.stringify(easing)}`);
  }
  return [property, p.from, p.to, period, easing];
}

export function checkFrames(list, ms) {
  if (!Array.isArray(list) || list.length === 0 || !list.every((s) => typeof s === "string")) {
    throw mockError("bad-motion", "frames(list, ms) expects a non-empty array of strings");
  }
  const step = finiteDuration(ms ?? 100, "frames interval");
  if (step < 16) throw mockError("bad-motion", "frames interval must be at least 16 milliseconds", RangeError);
  return [step, ...list];
}

export function checkSpin(ms) {
  const period = finiteDuration(ms ?? 1000, "spin period");
  if (period < 100) throw mockError("bad-motion", "spin period must be at least 100 milliseconds", RangeError);
  return [period];
}
