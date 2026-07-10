/*
 * runner-core.js — the pure logic of the gist runner.
 * No DOM, no fetch: everything here runs (and is tested) in Node as well as the browser.
 * Browser layer: index.html. Spec: Curriculum/Summer 2026/Gist Runner - Spec.md
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RunnerCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const RUNNABLE = [".ts", ".tsx", ".js", ".jsx"];
  const IMPORTABLE_DATA = [".json", ".csv", ".txt"];

  function extOf(name) {
    const i = name.lastIndexOf(".");
    return i === -1 ? "" : name.slice(i).toLowerCase();
  }
  function isRunnable(name) {
    return RUNNABLE.includes(extOf(name));
  }

  /** Decide mode + entry from a map of {filename: content}. */
  function classify(files) {
    const names = Object.keys(files);
    if (names.some((n) => n.toLowerCase() === "index.html")) {
      const entry = names.find((n) => n.toLowerCase() === "index.html");
      return { mode: "web", entry };
    }
    const indexEntry = names.find((n) => /^index\.(ts|tsx|js|jsx)$/i.test(n));
    if (indexEntry) return { mode: "node", entry: indexEntry };
    const runnables = names.filter(isRunnable);
    if (runnables.length === 1) return { mode: "node", entry: runnables[0] };
    if (runnables.length === 0) return { error: "Nothing to run here — no index.html and no .ts/.js file." };
    return { error: "Multiple runnable files and no index.* — name your entry index.ts." };
  }

  /** Node API shims, served when their specifier is imported. Closed list — see spec. */
  const SHIMS = {
    "readline-sync": [
      "// readline-sync shim — synchronous input via prompt(), echoed to the terminal.",
      "function question(q) {",
      "  q = q === undefined ? '' : String(q);",
      "  globalThis.__stdinOpen && globalThis.__stdinOpen();",
      "  const a = globalThis.prompt(q);",
      "  const answer = a === null ? '' : a;",
      "  globalThis.__stdinClose && globalThis.__stdinClose(q, answer);",
      "  return answer;",
      "}",
      "function questionInt(q) { return parseInt(question(q), 10); }",
      "function questionFloat(q) { return parseFloat(question(q)); }",
      "function keyInYN(q) { const a = question((q||'') + ' [y/n]: ').toLowerCase(); return a.startsWith('y'); }",
      "export { question, questionInt, questionFloat, keyInYN };",
      "export default { question, questionInt, questionFloat, keyInYN };",
    ].join("\n"),

    "process": [
      "const p = globalThis.__processShim || { argv: ['runner', 'index.ts'], env: {}, exit(code){ throw new Error('process.exit(' + (code||0) + ')'); }, stdout: { write(s){ globalThis.__stdoutWrite ? globalThis.__stdoutWrite(String(s)) : console.log(s); } } };",
      "export default p;",
      "export const argv = p.argv; export const env = p.env;",
      "export const exit = p.exit; export const stdout = p.stdout;",
    ].join("\n"),

    "node:fs": [
      "// node:fs shim — in-memory FS seeded with the gist's own files. Sync subset only.",
      "const files = globalThis.__gistFiles || {};",
      "const mem = Object.assign({}, files);",
      "function norm(p) { return String(p).replace(/^\\.\\//, ''); }",
      "export function readFileSync(p, _enc) {",
      "  const k = norm(p);",
      "  if (!(k in mem)) throw new Error(\"ENOENT: no such file '\" + p + \"' (runner fs sees only the gist's files)\");",
      "  return mem[k];",
      "}",
      "export function writeFileSync(p, data) { mem[norm(p)] = String(data); console.log('[fs] wrote ' + norm(p) + ' (' + String(data).length + ' bytes, in-memory)'); }",
      "export function existsSync(p) { return norm(p) in mem; }",
      "export function readdirSync() { return Object.keys(mem); }",
      "export default { readFileSync, writeFileSync, existsSync, readdirSync };",
    ].join("\n"),

    "node:path": [
      "export function join(...parts) { return parts.join('/').replace(/\\/+/g, '/'); }",
      "export function basename(p) { const s = String(p).split('/'); return s[s.length - 1]; }",
      "export function extname(p) { const b = basename(p); const i = b.lastIndexOf('.'); return i <= 0 ? '' : b.slice(i); }",
      "export function dirname(p) { const s = String(p).split('/'); s.pop(); return s.join('/') || '.'; }",
      "export default { join, basename, extname, dirname };",
    ].join("\n"),
  };
  SHIMS["node:process"] = SHIMS["process"];
  SHIMS["fs"] = SHIMS["node:fs"];
  SHIMS["path"] = SHIMS["node:path"];

  /** Friendly module served for known-Node-but-unsupported imports. */
  function nodeErrorModule(spec) {
    return "throw new Error(" + JSON.stringify(
      '"' + spec + '" needs real Node — that\'s a fall-toolchain thing. The runner shims only: readline-sync, process, node:fs (sync reads), node:path.'
    ) + ");";
  }
  const NODE_ONLY = /^(node:.*|child_process|http|https|net|os|crypto|stream|worker_threads|cluster|dgram|tls|readline)$/;

  /** Collect import/export specifiers from compiled ES-module JS (regex-based; fine for classroom code). */
  const SPEC_RE = /(from\s*|import\s*\(\s*|import\s+)(["'])([^"']+)\2/g;
  function collectSpecifiers(js) {
    const out = [];
    let m;
    SPEC_RE.lastIndex = 0;
    while ((m = SPEC_RE.exec(js)) !== null) out.push(m[3]);
    return out;
  }
  function rewriteSpecifiers(js, mapFn) {
    return js.replace(SPEC_RE, (whole, lead, q, spec) => lead + q + mapFn(spec) + q);
  }

  /** Resolve './helpers' against the gist's files: exact, or +ts/tsx/js/jsx/json/csv/txt. */
  function resolveRelative(spec, files) {
    const bare = spec.replace(/^\.\//, "");
    if (bare in files) return bare;
    for (const ext of RUNNABLE.concat(IMPORTABLE_DATA)) {
      if (bare + ext in files) return bare + ext;
    }
    return null;
  }

  /** Wrap non-JS importables as ES modules. */
  function wrapDataModule(name, content) {
    const ext = extOf(name);
    if (ext === ".json") return "export default " + content.trim() + ";";
    // csv / txt → raw string
    return "export default " + JSON.stringify(content) + ";";
  }

  /**
   * Build the module list in dependency order (leaves first).
   * transpile(name, source) -> { js, diagnostics: [string] }
   * Returns { order: [{name, js, deps}], diagnostics: [..], error? }
   */
  function buildGraph(files, entryName, transpile) {
    const compiled = {}; // name -> {js, deps}
    const diagnostics = [];
    const visiting = new Set();
    const done = new Set();
    const order = [];

    function compileOne(name) {
      const ext = extOf(name);
      if (IMPORTABLE_DATA.includes(ext)) return { js: wrapDataModule(name, files[name]), deps: [] };
      if (ext === ".js" || ext === ".jsx") {
        const js = ext === ".jsx" ? transpile(name, files[name]).js : files[name];
        return { js, deps: collectSpecifiers(js).filter((s) => s.startsWith("./")) };
      }
      const r = transpile(name, files[name]);
      (r.diagnostics || []).forEach((d) => diagnostics.push(name + ": " + d));
      return { js: r.js, deps: collectSpecifiers(r.js).filter((s) => s.startsWith("./")) };
    }

    function visit(name, chain) {
      if (done.has(name)) return null;
      if (visiting.has(name)) {
        return "Circular imports: " + chain.concat(name).join(" → ") + " — simplify (no cycles).";
      }
      visiting.add(name);
      const unit = compileOne(name);
      compiled[name] = unit;
      for (const dep of unit.deps) {
        const resolved = resolveRelative(dep, files);
        if (!resolved) return 'Cannot find "' + dep + '" among the gist\'s files (imported by ' + name + ").";
        const err = visit(resolved, chain.concat(name));
        if (err) return err;
      }
      visiting.delete(name);
      done.add(name);
      order.push({ name, js: unit.js, deps: unit.deps });
      return null;
    }

    const err = visit(entryName, []);
    if (err) return { error: err, diagnostics };
    return { order, diagnostics };
  }

  /**
   * Final rewrite pass: given the ordered modules and a makeUrl(name) for already-built
   * relative modules, map every specifier to its runnable form.
   */
  function finalizeModule(js, files, urlOf) {
    return rewriteSpecifiers(js, (spec) => {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const resolved = resolveRelative(spec, files);
        return resolved ? urlOf(resolved) : spec;
      }
      if (spec in SHIMS) return urlOf("__shim__:" + spec);
      if (NODE_ONLY.test(spec)) return urlOf("__nodeerr__:" + spec);
      if (/^https?:\/\//.test(spec) || spec.startsWith("data:")) return spec;
      return "https://esm.sh/" + spec; // bare npm specifier (name or name@version)
    });
  }

  /** Rewrite index.html for web mode: gist-file script/link references become inline/data equivalents. */
  function rewriteHtml(html, files, urlOf) {
    let out = html.replace(
      /<script([^>]*)\ssrc=(["'])\.?\/?([^"']+)\2([^>]*)>\s*<\/script>/gi,
      (whole, pre, q, src, post) => {
        const resolved = resolveRelative("./" + src, files);
        if (!resolved || !isRunnable(resolved)) return whole;
        return '<script type="module" src="' + urlOf(resolved) + '"></script>';
      }
    );
    out = out.replace(
      /<link([^>]*)\shref=(["'])\.?\/?([^"']+\.css)\2([^>]*)>/gi,
      (whole, pre, q, href) => {
        const resolved = resolveRelative("./" + href, files);
        if (!resolved) return whole;
        return "<style>\n" + files[resolved] + "\n</style>";
      }
    );
    return out;
  }

  /** data: URL for a JS module (origin-free — importable from the opaque sandbox). */
  function toDataUrl(js) {
    if (typeof btoa === "function") {
      return "data:text/javascript;base64," + btoa(unescape(encodeURIComponent(js)));
    }
    return "data:text/javascript;base64," + Buffer.from(js, "utf8").toString("base64");
  }

  return {
    classify, extOf, isRunnable, SHIMS, NODE_ONLY, nodeErrorModule,
    collectSpecifiers, rewriteSpecifiers, resolveRelative, wrapDataModule,
    buildGraph, finalizeModule, rewriteHtml, toDataUrl,
  };
});
