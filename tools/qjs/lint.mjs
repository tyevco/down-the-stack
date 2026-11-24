// Static scan of mods/down-the-stack for QuickJS-ng / herdr-sandbox hazards (acorn AST, no execution).
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";

const RISKY_MEMBERS = new Set([
  "at", "replaceAll", "findLast", "findLastIndex", "toSorted", "toReversed", "toSpliced", "with", "groupBy", "hasOwn",
  "toLocaleString", "toLocaleDateString", "toLocaleTimeString", "toLocaleUpperCase", "toLocaleLowerCase", "localeCompare",
  "normalize", "isWellFormed", "toWellFormed", "fromAsync", "withResolvers", "union", "intersection", "difference",
  "symmetricDifference", "isSubsetOf", "matchAll", "parse", "toISOString", "getTimezoneOffset", "toFixed", "toPrecision",
  "toExponential", "codePointAt", "fromCodePoint", "padStart", "padEnd", "trimStart", "trimEnd", "flat", "flatMap", "fromEntries",
]);
const RISKY_GLOBALS = new Set(["Intl", "structuredClone", "TextEncoder", "TextDecoder", "atob", "btoa", "URL", "queueMicrotask", "setTimeout",
  "setInterval", "clearTimeout", "clearInterval", "eval", "Function", "WeakRef", "FinalizationRegistry", "Atomics", "SharedArrayBuffer", "require",
  "process", "Buffer", "performance", "crypto", "fetch", "window", "document", "navigator", "localStorage", "sessionStorage", "globalThis"]);

// ES2017-2019 formatting helpers QuickJS-ng implements exactly like V8 (verified by probe.js)
const FORMAT = new Set(["toFixed", "toPrecision", "toExponential", "padStart", "padEnd", "trimStart", "trimEnd", "flat", "flatMap", "fromEntries", "codePointAt", "fromCodePoint", "getTimezoneOffset", "toISOString"]);

// own property names of the five prototypes herdr freezes (sandbox.rs:200-212)
const FROZEN = new Set();
for (const proto of [Object.prototype, Array.prototype, Function.prototype, String.prototype, Number.prototype]) {
  for (const k of Object.getOwnPropertyNames(proto)) FROZEN.add(k);
}

const OBJ_PROTO = new Set(Object.getOwnPropertyNames(Object.prototype));

function walk(node, visit, parent = null, key = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent, key);
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "start" || k === "end") continue;
    const v = node[k];
    if (Array.isArray(v)) for (const c of v) walk(c, visit, node, k);
    else if (v && typeof v.type === "string") walk(v, visit, node, k);
  }
}

function patternNames(p, out) {
  if (!p) return;
  switch (p.type) {
    case "Identifier": out.add(p.name); break;
    case "ObjectPattern": for (const pr of p.properties) patternNames(pr.type === "RestElement" ? pr.argument : pr.value, out); break;
    case "ArrayPattern": for (const e of p.elements) patternNames(e, out); break;
    case "RestElement": patternNames(p.argument, out); break;
    case "AssignmentPattern": patternNames(p.left, out); break;
  }
}

export function lint(modDir) {
  const files = [];
  const rec = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== "art") rec(p); } else if (e.name.endsWith(".js")) files.push(p); } };
  rec(modDir);
  const features = {};
  const feat = (k) => { features[k] = (features[k] || 0) + 1; };
  const risky = [];
  const regexes = [];
  const regexFlags = {};
  const regexNotes = [];
  const override = [];
  const globalsUsed = {};
  const sorts = [];
  let computedWrites = 0;
  let lines = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    lines += src.split("\n").length;
    const rel = path.relative(modDir, file);
    let ast;
    try {
      ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", locations: true, allowAwaitOutsideFunction: false });
    } catch (e) {
      risky.push(`${rel}: PARSE ERROR ${e.message}`);
      continue;
    }
    const declared = new Set();
    walk(ast, (n) => {
      if (n.type === "ImportSpecifier" || n.type === "ImportDefaultSpecifier" || n.type === "ImportNamespaceSpecifier") declared.add(n.local.name);
      if (n.type === "VariableDeclarator") patternNames(n.id, declared);
      if ((n.type === "FunctionDeclaration" || n.type === "ClassDeclaration" || n.type === "FunctionExpression" || n.type === "ClassExpression") && n.id) declared.add(n.id.name);
      if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") for (const p of n.params) patternNames(p, declared);
      if (n.type === "CatchClause" && n.param) patternNames(n.param, declared);
      if (n.type === "LabeledStatement") declared.add(n.label.name);
    });
    walk(ast, (n, parent, key) => {
      const at = `${rel}:${n.loc.start.line}`;
      switch (n.type) {
        case "PropertyDefinition": feat(n.static ? "static class field" : "class field"); break;
        case "PrivateIdentifier": feat("#private"); risky.push(`${at}: private #${n.name} (ARCHITECTURE §2.14 forbids)`); break;
        case "StaticBlock": feat("static block"); risky.push(`${at}: static block (ARCHITECTURE §2.14 forbids)`); break;
        case "ChainExpression": feat("optional chaining"); break;
        case "LogicalExpression": if (n.operator === "??") feat("??"); break;
        case "AssignmentExpression":
          if (["??=", "||=", "&&="].includes(n.operator)) feat(n.operator);
          if (n.left.type === "MemberExpression") {
            if (!n.left.computed && n.left.property.type === "Identifier" && FROZEN.has(n.left.property.name) && n.left.property.name !== "length") override.push(`${at}: assignment to .${n.left.property.name}${OBJ_PROTO.has(n.left.property.name) ? "  (Object.prototype name: throws on ANY plain object)" : "  (only throws if the target inherits it: array/function/string/number)"}`);
            if (n.left.computed && n.left.property.type === "Literal" && FROZEN.has(String(n.left.property.value))) override.push(`${at}: assignment to ["${n.left.property.value}"]`);
            if (n.left.computed && n.left.property.type !== "Literal") computedWrites++;
          }
          break;
        case "BinaryExpression": if (n.operator === "**") feat("**"); break;
        case "AwaitExpression": feat("await"); break;
        case "ForOfStatement": if (n.await) feat("for await"); break;
        case "ImportExpression": feat("dynamic import()"); break;
        case "MetaProperty": feat(`${n.meta.name}.${n.property.name}`); break;
        case "ImportDeclaration":
          if (n.source.value.endsWith(".json")) risky.push(`${at}: JSON import`);
          if (n.source.value.startsWith(".") && !n.source.value.endsWith(".js")) risky.push(`${at}: relative import without .js: ${n.source.value}`);
          if (n.attributes && n.attributes.length) risky.push(`${at}: import attributes`);
          break;
        case "Literal":
          if (n.regex) {
            regexes.push(`${at}: /${n.regex.pattern}/${n.regex.flags}`);
            for (const f of n.regex.flags) regexFlags[f] = (regexFlags[f] || 0) + 1;
            if (/\(\?<[=!]/.test(n.regex.pattern)) regexNotes.push(`${at}: lookbehind /${n.regex.pattern}/`);
            if (/\\p\{/.test(n.regex.pattern)) regexNotes.push(`${at}: unicode property /${n.regex.pattern}/`);
            if (/[vd]/.test(n.regex.flags)) regexNotes.push(`${at}: flag ${n.regex.flags}`);
          }
          if (typeof n.bigint === "string") feat("BigInt");
          if (typeof n.raw === "string" && /\d_\d/.test(n.raw) && typeof n.value === "number") feat("numeric separator");
          break;
        case "NewExpression":
          if (n.callee.type === "Identifier" && n.callee.name === "RegExp") regexNotes.push(`${at}: new RegExp(...)`);
          if (n.callee.type === "Identifier" && n.callee.name === "Date" && n.arguments.length === 1 && (n.arguments[0].type === "Literal" && typeof n.arguments[0].value === "string" || n.arguments[0].type === "TemplateLiteral")) risky.push(`${at}: new Date(string)`);
          break;
        case "MemberExpression":
          if (!n.computed && n.property.type === "Identifier" && RISKY_MEMBERS.has(n.property.name) && parent && parent.type === "CallExpression" && key === "callee") {
            const obj = n.object.type === "Identifier" ? n.object.name : n.object.type === "MemberExpression" && !n.object.computed ? `…${n.object.property.name}` : "…";
            const name = `${obj}.${n.property.name}`;
            if (n.property.name === "parse" && obj !== "Date") break;
            if (FORMAT.has(n.property.name)) { feat(`call .${n.property.name}()`); break; }
            risky.push(`${at}: ${name}()`);
          }
          break;
        case "CallExpression":
          if (n.callee.type === "MemberExpression" && !n.callee.computed && n.callee.property.name === "sort") {
            const cmp = n.arguments[0];
            if (!cmp) sorts.push(`${at}: .sort() without comparator`);
            else if ((cmp.type === "ArrowFunctionExpression" || cmp.type === "FunctionExpression")) {
              let body = cmp.body;
              if (body.type === "BlockStatement") {
                const ret = body.body.find((s) => s.type === "ReturnStatement");
                body = ret ? ret.argument : null;
              }
              if (body && body.type === "BinaryExpression" && ["<", ">", "<=", ">=", "===", "!==", "==", "!="].includes(body.operator)) sorts.push(`${at}: comparator returns a boolean (${body.operator}) — engine-dependent order`);
            }
          }
          break;
        case "Identifier": {
          // references (not property keys / member properties / declarations)
          if (parent && ((parent.type === "MemberExpression" && key === "property" && !parent.computed) || (parent.type === "Property" && key === "key" && !parent.computed) || (parent.type === "PropertyDefinition" && key === "key") || (parent.type === "MethodDefinition" && key === "key") || parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement" || (parent.type === "ImportSpecifier") || (parent.type === "ExportSpecifier"))) break;
          if (!declared.has(n.name)) (globalsUsed[n.name] = globalsUsed[n.name] || []).push(at);
          break;
        }
      }
    });
    for (const g of Object.keys(globalsUsed)) if (RISKY_GLOBALS.has(g)) for (const a of globalsUsed[g]) if (a.startsWith(rel + ":")) risky.push(`${a}: global ${g}`);
    // top-level await
    for (const st of ast.body) {
      let found = false;
      walk(st, (n) => { if (n.type === "AwaitExpression") found = true; if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {} });
      if (found && st.type !== "FunctionDeclaration" && st.type !== "ClassDeclaration" && !(st.type === "ExportNamedDeclaration" && st.declaration && /Function|Class/.test(st.declaration.type)) && !(st.type === "ExportDefaultDeclaration")) {
        // only report when the await is not nested in a function
        let top = false;
        const scan = (n, inFn) => {
          if (!n || typeof n.type !== "string") return;
          if (n.type === "AwaitExpression" && !inFn) top = true;
          const fn = inFn || /Function/.test(n.type);
          for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => scan(c, fn)); else if (v && typeof v.type === "string") scan(v, fn); }
        };
        scan(st, false);
        if (top) risky.push(`${rel}:${st.loc.start.line}: top-level await`);
      }
    }
  }
  return { files: files.length, lines, features, risky, regexes, regexFlags, regexNotes, override, computedWrites, globals: Object.fromEntries(Object.entries(globalsUsed).map(([k, v]) => [k, v.length])), sorts };
}
