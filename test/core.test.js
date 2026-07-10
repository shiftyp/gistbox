/* Unit tests for runner-core.js — run with: node test/core.test.js
 * Uses the real `typescript` package as a stand-in for the pinned CDN compiler. */
const assert = require("assert");
const ts = require("typescript");
const C = require("../runner-core.js");

let passed = 0, failed = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
async function runAll() {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log("  ok  " + name); }
    catch (e) { failed++; console.error(" FAIL " + name + "\n      " + e.message); }
  }
}

function transpile(name, source) {
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    fileName: name,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  });
  return {
    js: out.outputText,
    diagnostics: (out.diagnostics || []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
  };
}

// ---------- classify ----------
t("classify: index.html wins → web mode", () => {
  const r = C.classify({ "index.html": "<html>", "index.ts": "x", "style.css": "" });
  assert.equal(r.mode, "web"); assert.equal(r.entry, "index.html");
});
t("classify: index.ts → node mode", () => {
  const r = C.classify({ "index.ts": "x", "helpers.ts": "y" });
  assert.equal(r.mode, "node"); assert.equal(r.entry, "index.ts");
});
t("classify: single runnable without index name", () => {
  const r = C.classify({ "main.ts": "x", "notes.md": "hi" });
  assert.equal(r.mode, "node"); assert.equal(r.entry, "main.ts");
});
t("classify: ambiguous → error", () => {
  const r = C.classify({ "a.ts": "x", "b.ts": "y" });
  assert.ok(r.error && r.error.includes("index.ts"));
});
t("classify: nothing runnable → error", () => {
  const r = C.classify({ "notes.md": "hi" });
  assert.ok(r.error);
});

// ---------- specifiers ----------
t("collectSpecifiers finds static, dynamic, bare-import forms", () => {
  const js = 'import a from "./a";\nimport("./b.ts");\nimport "./c";\nexport { x } from "./d";\nimport _ from "lodash";';
  const s = C.collectSpecifiers(js);
  ["./a", "./b.ts", "./c", "./d", "lodash"].forEach((x) => assert.ok(s.includes(x), x));
});
t("resolveRelative: extension inference across types", () => {
  const files = { "helpers.ts": "", "data.json": "", "log.txt": "", "comp.tsx": "" };
  assert.equal(C.resolveRelative("./helpers", files), "helpers.ts");
  assert.equal(C.resolveRelative("./helpers.ts", files), "helpers.ts");
  assert.equal(C.resolveRelative("./data.json", files), "data.json");
  assert.equal(C.resolveRelative("./data", files), "data.json");
  assert.equal(C.resolveRelative("./comp", files), "comp.tsx");
  assert.equal(C.resolveRelative("./nope", files), null);
});

// ---------- data modules ----------
t("wrapDataModule: json becomes default export", () => {
  const m = C.wrapDataModule("d.json", '{"a": 1}');
  assert.ok(m.startsWith("export default {"));
});
t("wrapDataModule: csv becomes raw string", () => {
  const m = C.wrapDataModule("d.csv", "a,b\n1,2");
  assert.ok(m.includes(JSON.stringify("a,b\n1,2")));
});

// ---------- graph ----------
t("buildGraph: chain compiles leaves-first", () => {
  const files = {
    "index.ts": 'import { two } from "./mid";\nconsole.log(two());',
    "mid.ts": 'import { one } from "./leaf";\nexport function two(): number { return one() + 1; }',
    "leaf.ts": "export function one(): number { return 1; }",
  };
  const g = C.buildGraph(files, "index.ts", transpile);
  assert.ok(!g.error, g.error);
  assert.deepEqual(g.order.map((m) => m.name), ["leaf.ts", "mid.ts", "index.ts"]);
});
t("buildGraph: cycle detected with a readable message", () => {
  const files = {
    "index.ts": 'import "./a";',
    "a.ts": 'import "./b";',
    "b.ts": 'import "./a";',
  };
  const g = C.buildGraph(files, "index.ts", transpile);
  assert.ok(g.error && g.error.includes("Circular"), g.error);
});
t("buildGraph: missing relative import is a friendly error", () => {
  const g = C.buildGraph({ "index.ts": 'import "./ghost";' }, "index.ts", transpile);
  assert.ok(g.error && g.error.includes("ghost"));
});
t("buildGraph: json import participates in the graph", () => {
  const files = { "index.ts": 'import data from "./data.json";\nconsole.log(data.n);', "data.json": '{"n": 7}' };
  const g = C.buildGraph(files, "index.ts", transpile);
  assert.ok(!g.error, g.error);
  assert.equal(g.order[0].name, "data.json");
  assert.ok(g.order[0].js.includes("export default"));
});
t("buildGraph: syntax diagnostics are reported per file", () => {
  const g = C.buildGraph({ "index.ts": "let x: = 5;" }, "index.ts", transpile);
  assert.ok(g.diagnostics.length > 0);
});
t("transpile strips types (type erasure)", () => {
  const g = C.buildGraph({ "index.ts": "let n: number = 7;\nconsole.log(n);" }, "index.ts", transpile);
  assert.ok(!g.order[0].js.includes(": number"));
});
t("transpile handles tsx", () => {
  const g = C.buildGraph(
    { "index.tsx": 'import React from "react";\nconst x = <div>hi</div>;\nconsole.log("ok");' },
    "index.tsx", transpile
  );
  assert.ok(!g.error, g.error);
  assert.ok(g.order[0].js.includes("jsx"));
});

// ---------- finalize ----------
t("finalizeModule: relative → url, shim → shim url, bare → esm.sh, node-only → error module", () => {
  const files = { "helpers.ts": "" };
  const js = 'import h from "./helpers";\nimport r from "readline-sync";\nimport _ from "lodash";\nimport v from "lodash@4.17.21";\nimport cp from "child_process";';
  const urls = { "helpers.ts": "data:HELPERS", "__shim__:readline-sync": "data:SHIM", "__nodeerr__:child_process": "data:ERR" };
  const out = C.finalizeModule(js, files, (k) => urls[k]);
  assert.ok(out.includes('"data:HELPERS"'));
  assert.ok(out.includes('"data:SHIM"'));
  assert.ok(out.includes('"https://esm.sh/lodash"'));
  assert.ok(out.includes('"https://esm.sh/lodash@4.17.21"'));
  assert.ok(out.includes('"data:ERR"'));
});
t("shims exist for the documented closed list and parse as modules", () => {
  for (const name of ["readline-sync", "process", "node:process", "node:fs", "fs", "node:path", "path"]) {
    assert.ok(C.SHIMS[name], name + " missing");
    const r = transpile("shim.ts", C.SHIMS[name]);
    assert.equal((r.diagnostics || []).length, 0, name + " has syntax errors: " + r.diagnostics);
  }
});
t("NODE_ONLY matches the loud-error tier, not npm packages", () => {
  ["node:http", "child_process", "readline", "crypto"].forEach((s) => assert.ok(C.NODE_ONLY.test(s), s));
  ["lodash", "react", "canvas-confetti", "sql.js"].forEach((s) => assert.ok(!C.NODE_ONLY.test(s), s));
});

// ---------- shim behavior (executed) ----------
t("readline-sync shim: question() uses prompt and returns the answer", async () => {
  const js = transpile("s.ts", C.SHIMS["readline-sync"]).js;
  global.prompt = () => "42";
  const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  assert.equal(mod.question("n? "), "42");
  assert.equal(mod.questionInt("n? "), 42);
  delete global.prompt;
});
t("node:fs shim: reads gist files, errors on missing", async () => {
  global.__gistFiles = { "data.csv": "a,b" };
  const js = transpile("s.ts", C.SHIMS["node:fs"]).js;
  const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  assert.equal(mod.readFileSync("./data.csv"), "a,b");
  assert.throws(() => mod.readFileSync("./nope.csv"), /ENOENT/);
  delete global.__gistFiles;
});

// ---------- web mode ----------
t("rewriteHtml: script src → module data url, css link inlined", () => {
  const files = { "index.html": "", "index.ts": "", "style.css": "body{color:red}" };
  const html = '<html><head><link rel="stylesheet" href="style.css"></head>' +
               '<body><script src="./index.ts"></script></body></html>';
  const out = C.rewriteHtml(html, files, (k) => "data:URL-" + k);
  assert.ok(out.includes('type="module" src="data:URL-index.ts"'));
  assert.ok(out.includes("<style>\nbody{color:red}\n</style>"));
  assert.ok(!out.includes("link rel"));
});

// ---------- end-to-end (node-side simulation of the browser pipeline) ----------
t("e2e: multi-file program with json + npm-style rewrite produces runnable modules", async () => {
  const files = {
    "index.ts": 'import { total } from "./calc";\nimport data from "./nums.json";\nconsole.log(total(data.values));',
    "calc.ts": "export function total(xs: number[]): number { let t = 0; for (const x of xs) t += x; return t; }",
    "nums.json": '{"values": [1, 2, 3, 4]}',
  };
  const g = C.buildGraph(files, "index.ts", transpile);
  assert.ok(!g.error, g.error);
  const urls = {};
  for (const mod of g.order) {
    const finalJs = C.finalizeModule(mod.js, files, (k) => urls[k]);
    urls[mod.name] = C.toDataUrl(finalJs);
  }
  const logs = [];
  const origLog = console.log; console.log = (...a) => logs.push(a.join(" "));
  try { await import(urls["index.ts"]); } finally { console.log = origLog; }
  assert.deepEqual(logs, ["10"]);
});

(async () => {
  await runAll();
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
