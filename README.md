# runner

A [bl.ocks](https://github.com/mbostock/bl.ocks.org)-style output surface for TypeScript gists.
**No code view** — the gist is where you read; the runner is what the code does.

```
runner/?gist=<id>          run a gist
runner/#code=<lz-string>   run code embedded in the URL (TypeScript Playground-compatible)
```

Division of labor: **gist = read · runner = behavior · Playground = edit.**

## What it runs

| Gist contains | Mode |
|---|---|
| `index.html` | **Web mode** — the page renders full-viewport; `<script src="./index.ts">` and `<link href="./style.css">` are rewritten to compiled/inlined equivalents |
| `index.ts` / `.tsx` / `.js` (or a single runnable file) | **Node mode** — full-page terminal (xterm.js), console output, auto-runs on load |

Also understood: relative imports between gist files (`./helpers`, extension optional), `.json` imports (default export), `.csv`/`.txt` imports (raw string), bare npm imports via [esm.sh](https://esm.sh) (`lodash`, `name@version`), and JSX (`react-jsx`).

## Node API shims (closed list)

| import | behavior |
|---|---|
| `readline-sync` | `question()` backed by `prompt()`, echoed to the terminal. Synchronous — and since it's a real npm package, the same gist runs unmodified in actual Node after `npm i readline-sync` |
| `process` | `argv` (seed extra args with `?args=a b c`), `env` (empty), `exit()`, `stdout.write` |
| `node:fs` / `fs` | sync subset over an in-memory FS **seeded with the gist's own files** — `readFileSync("./data.csv")` just works |
| `node:path` / `path` | `join`, `basename`, `extname`, `dirname` |
| anything else Node-only | loud, friendly error |

## URL options

`?bare=1` start with the source pill hidden · `?timeout=<ms>` watchdog override (default 5000) · `?args=...` extra `process.argv` entries.

## Deploy (GitHub Pages)

1. New public repo, add `index.html`, `runner-core.js`, `test/`.
2. Settings → Pages → deploy from branch → `main` / root.
3. Done: `https://<user>.github.io/<repo>/?gist=...`
   Custom domain later: add a CNAME (`run.<yourdomain>`) in Pages settings.

## Architecture notes

- One static page. Core logic lives in `runner-core.js` (pure, Node-tested: `node test/core.test.js` with `typescript@5.5.4` installed). The browser layer (`index.html`) does fetch, xterm, and the sandboxed iframe.
- Programs run as ES modules in a **sandboxed iframe** (`allow-scripts allow-modals`, opaque origin). Modules ship as `data:` URLs because blob URLs are origin-bound and unreachable from an opaque origin.
- Watchdog: no output for 5s (and no prompt open) → iframe torn down, timeout reported.
- Compiler is pinned (`typescript@5.5.4` via jsDelivr). Type *checking* is the Playground's job — the runner surfaces syntax errors and runtime behavior (transpile-only, no cross-file type checks).
- `debugger;` works with DevTools open — you step through the compiled JS (type erasure, live).

## Known constraints

- Gist API: 60 requests/hr/IP unauthenticated (per-viewer, fine for a class). Heavy grading sessions: authenticated requests get 5,000/hr — curl with a token or wait; the runner itself never ships a token (static pages can't keep secrets).
- Secret gists are unlisted, **not private**.
- esm.sh is a runtime dependency for npm imports only.
- The `prompt()` input modal is intentionally boring; inline terminal input arrives with the fall (`node:readline/promises`) path.

## v2 parking lot

Inline terminal input (xterm readline addon) · post-exit expression REPL · browser storage via a sacrificial sandbox origin (`sandbox.<domain>` as a second Pages repo, or a sibling github.io org) · module-support PR as fall code-reading material.
