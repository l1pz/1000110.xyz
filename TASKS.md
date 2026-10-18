# Tasks

Pick the first unchecked task. One task per session. Log a 2-line handoff at the bottom.

## Phase 0: Foundation
- [x] Vite, AGENTS/ARCHITECTURE/TASKS docs
- [x] TypeScript, Biome, Vitest, `npm run check`, build guard test
- [x] `public/` assets, multi-page `vite.config.js`, CSS color variables
- [x] Card engine rewritten: no duplicate methods, escaped HTML, bounds errors, tests
- [x] Review and approve the "feature modules" plan in `ARCHITECTURE.md`
- [x] Add GitHub Actions CI running `npm run check`; decide hosting and add deploy
- [x] Fill in real contact info (phone placeholder) and make the `<noscript>` fallback match the JS cards (consider generating it at build time)
- [x] Tiny: bring back the fake phone line `phone: +36 xx xxx xxxx` (the +36 shows Hungary; never a real number) in the JS contact card and the `<noscript>` copy. Keep it the same in both and keep the card at 32 rows x 41 cols (remove the 2 extra blank rows added before the binary footer)

## Phase 1: Engine polish
- [x] Border styles (none, retro, ascii, single, double, rounded); rounded is hardcoded, toggle removed
- [x] Pick a font with full box-drawing coverage (DejaVu Sans Mono) and fix the `/fonts/stylesheet.css` 404 (fonts moved to `public/fonts/`)
- [x] Card footer system: `drawFooter` anchors the 4-line binary footer at the bottom; home cards use it
- [x] JGS font: tried as the only font and rejected (hard to read); no toggle wanted, DejaVu Sans Mono stays

## Phase 2: Blog
- [x] Markdown loader + frontmatter (title, date, tags, slug)
- [x] Blog card on home grid
- [x] TUI reading view with progress meter (pager-style page, not a card; see DECISIONS.md)
- [x] RSS feed script

## Phase 2a: Design system (DESIGN.md)
- [x] Step 1: shared shell (`src/core/shell.ts`, `styles/shell.css`); the blog uses it
- [x] Step 2: phone rules (fluid font under ~400px, safe area, tap targets, short window names; checked at 360 and 390)
- [x] Step 3: home charm (colors, status bar, keyboard navigation) merged in; home page gets the shell, a `whoami` block and command-style card titles
- [x] Step 4: blog card rows (kept as `date  title`, see DESIGN.md)
- [x] Step 5: rules into `AGENTS.md` and `DECISIONS.md`

## Phase 2c: Consistency (DESIGN.md)
- [x] Site map + page frame + `assertShell` guard
- [x] Shared status line (windows, clock, progress) and keys on every page
- [x] Blog index, post and not-found through the frame
- [x] Home as a session; home cards, blog card, keynav and card windows removed (card engine kept)
- [x] Experiments listing and the fluid dynamics page on the shell
- [x] Guards: site map vs `vite.config.js`, built pages have the shell; docs updated

## Phase 2b: Home page charm (done, then superseded: the home page is now a session, see Phase 2c; the card colors, window list and card keys it built were reworked or removed)
- [x] Color pass: card titles yellow, borders gray, binary footers dim gray, accent colors on art (card engine style spans; `<noscript>` follows)
- [x] tmux-style status bar on the home page: window list `1:about 2:projects 3:blog ...` (focused one marked) + live clock; shares its CSS with the blog status line
- [x] Keyboard navigation: h/j/k/l or arrows move a highlight between cards (focused border turns yellow), Enter follows the card's first link, 1-5 jump to a card, Esc clears

### Home page ideas (parked, in rough priority; user liked all of them)
- Command prompt `$ _` on the home page: `help`, `ls`, `blog`, `cat about`, `theme`; the place for easter eggs (`sudo`, `xyzzy`, `rm -rf /`, random `fortune` line)
- Boot sequence on the first visit per session: a few typed lines (`1000110.xyz cyberdeck v0.1 ... ok`), then the cards print in; skippable with any key; keep it short
- Living cards: clock, a "now" card (building / listening), the typewriter typing a line, animated art; the Oracle is the big version
- Later, on the blog: table-of-contents widget card beside a post (wide screens), build-time `<noscript>` posts

## Phase 3: Tools (the full catalogue and build order live in `TOOLS.md`)
- [x] Tools registry + `/tools/` listing, case converter, encode/decode playground
- [x] Tools batch A, generators and crypto: hash generator, password and passphrase generator, UUID / ULID / NanoID (implementation batch: one branch, one commit per tool, each tool still its own page; see `TOOLS.md`)
- [x] Tools batch B, text and data: JSON formatter, text counter, diff checker, regex tester with explanation
- [x] Tools batch C, calculators: CIDR / subnet calculator, timestamp and time zone converter, color converter and contrast checker
- [ ] Image to ASCII / dither studio
- [ ] Fluid dynamics experiment (currently an empty stub)
- [ ] Scratchpad (see `TOOLS.md`, Writing / life)
- [ ] Rest of the `TOOLS.md` catalogue, one tool per session

## Phase 3b: Tool upgrades (make the existing tools less basic)
Pick the first unchecked batch. One branch per batch, one commit and tests per tool. Logic stays pure in the tool folder; no new runtime dependency without asking (HIBP check in the password tool needs a network call: ask first).
- [x] Batch U1, shared plumbing (benefits all 13 tools): shareable state in the URL (`/tools/#json?i=...`, since the hash is already the route) with a "copy link" button; remembered options in localStorage; file drop and clipboard paste in the text tools (json, diff, count, encode, hash); `/` or `Ctrl-K` command palette over the registry; "send output to another tool" generalising the encode tool's "use output as input"; audit that every cheap tool updates live as you type, not on a button press
- [ ] Batch U1b, syntax highlighting: own branch `feat/tools-highlight` and its own session (user decision), after U1. Design (dependency approved by the user: `highlight.js`, installed from npm and bundled by Vite, self-hosted in `dist/`, never a CDN: no third-party requests, and the tools page says nothing is uploaded): `highlight(lang, text)` in one shared module returns escaped HTML with highlight classes. Generic languages (javascript / typescript, css, xml / html, markdown, bash) use `highlight.js` core with only those languages registered, imported only inside a lazy chunk so no page or tool that does not highlight pays for it; check the real bundle size in the build. json, diff (add / del lines) and regex (groups, classes, quantifiers; reuses the explainer's tokenizer) stay hand-written, small pure functions with tests. Colors: a short CSS block maps `hljs-*` and our own token classes to theme variables only. Editable fields use the overlay technique (a highlighted `<pre>` behind a transparent `<textarea>`, same font and metrics so the character grid never shifts; scroll synced); check drift on a phone at 360 and 390 (soft keyboard, selection), and fall back to read-only highlighted output if it misbehaves. Read-only output is a plain highlighted `<pre>`. Users: json in/out, diff, regex pattern, encode (html), color CSS export, JWT decoder, and the blog's code blocks.
- [ ] Batch U2, fixes and quick wins: regex runs in a Web Worker with a timeout (fixes the `(a+)+$` freeze); cidr parses `::ffff:1.2.3.4` and dotted netmasks `/255.255.255.0`; uuid decoder (timestamp inside UUIDv7 / ULID); hash of a dropped file plus "compare with expected" (check / cross); JWT decoder (in or next to encode)
- [ ] Batch U3, text and data: json (tree view with collapse, small JSONPath query, to CSV / YAML / TypeScript types, sort by value, diff of two JSONs, handles big input); diff (word and char highlight inside changed lines, side-by-side that stacks on phones, ignore whitespace/case, unified-diff export, patch applier); count (reading and speaking time, line / sentence / paragraph counts, word frequency, limit tracker for tweet / SMS / SEO lengths, UTF-8 and UTF-16 byte size); case (all variants as a list with copy buttons, smart split of camelCase input, more styles); regex (replace mode with `$1` preview, common-pattern library, should-match test cases, export to JS / Python / grep)
- [ ] Batch U4, generators and crypto: encode (Base32, Base58, Punycode, Unicode escapes, auto-detect suggestion); hash (all algorithms at once, CRC32, SHA-3, bcrypt-style cost note); password (per-class toggles, avoid ambiguous `0O1lI`, generate N at once, pronounceable mode, crack-time estimate); uuid (bulk N with format options, v1 / v5 / nil / max)
- [ ] Batch U5, calculators: cidr (subnet splitter, supernet / aggregate, "is IP in range?", binary mask view); time (many zones side by side, relative time, ISO week and day of year, date difference, cron explainer); color (palettes: complementary / triadic / analogous / shades, OKLCH / HSV / CMYK, `EyeDropper` picker, "fix this contrast" suggestion that nudges lightness to pass AA, CSS variable export)
- Check every UI change at 360 and 390 wide (the last three batches were never looked at in a browser).

## Phase 4: Gallery
- [ ] Gallery card, dither/ASCII <-> raw photo view, albums

## Phase 5: Polish
- [x] Theme picker (user asked for it before U1b; branch `feat/theme-picker`): six themes as `[data-theme]` blocks in `theme.css`, `src/core/theme.ts`, `plugins/theme-boot.js` (no flash), `/theme/` page, `◐` link and `t` key; no saved choice follows the system. Details in DESIGN.md 2b and DECISIONS.md.
- [ ] "Oracle": a small model thinking out loud 24/7, streamed to a card. One generator on the server (llama.cpp, in-process via llama-cpp-python, FastAPI, SSE broadcast, ring buffer so new visitors see text at once, connection cap, heartbeat), no visitor input. Output must be coherent: test candidate models (SmolLM2-360M, Llama 3.2 1B, Qwen2.5 1.5B, Gemma 3 1B) before choosing; RAM budget ~1.5 GB, low CPU (nice 19, throttled tokens, optional pause when nobody watches), Docker mem/cpu limits, Traefik, canned-line fallback in the card
- [ ] CRT scanline/glow toggle
- [ ] Optional key-click sounds

## Phase 6: Admin (hand-written, one shared admin with a module per feature; see DECISIONS.md)
Needs a short plan shown in the terminal before any code. Storage is decided: option A, the admin commits to the repo.
- [ ] 6a Admin infrastructure: one small backend service (the Oracle task can share its container and Traefik setup); Pocket ID (OIDC) forward auth on `/admin/` and `/api/` (oauth2-proxy or tinyauth in Traefik); a private `/admin/` shell page (`renderPage`, a `site.ts` entry with a new `hidden` flag so it gets no status line window and no public crumb link) that lists the modules like `ls modules/`; a service that commits files to the repo with a fine-grained GitHub token (`contents:write`, limited to the paths a module owns). Secrets (Pocket ID client id and secret, the GitHub token) live in the server's environment, never in the repo. Must work on a phone.
- [ ] 6b Blog module (`src/features/blog/`, routes under `/api/blog/`): add, edit and delete posts; write in the browser (textarea with a live preview that uses the blog's own `renderMarkdown` and styles) or upload raw `.md` files. The server re-validates every upload with the same `parsePost` rules (slug, date, size limit, `.md` only) and commits to `src/features/blog/posts/`, so the existing CI check rejects bad posts and the deploy publishes in about a minute. Drafts via `draft: true` in the frontmatter (admin list only, never in the public blog, home or RSS). Listing like `ls -l ~/blog` with drafts marked; editor as `$ vim posts/<slug>.md`.
- [ ] Later modules, same pattern: gallery (albums, uploads), Oracle controls. Pull shared code out of the blog module only when the second module arrives; do not design a framework from one example.
- Open: images are not supported by the Markdown subset yet, so uploading assets will come up as soon as posts want pictures.

## Handoff log
### Session 1 (2026-10-02)
- Done: Phase 0 foundation above (branch `chore/foundation`). `npm run check` passes.
- Next: user reviews the feature-module plan; then CI/hosting.

### Session 2 (2026-10-02)
- Done: user approved the feature-module plan; recorded in DECISIONS.md, ARCHITECTURE.md marked approved.
- Done: CI + deploy live. Merging to `main` rsyncs `dist/` to the netcup server (nginx container behind Traefik, `https://1000110.xyz`) as a restricted `deploy` user; see DECISIONS.md. Site renamed to 1000110.xyz.
- Next: contact card done (see Session 3); then Phase 1.

### Session 3 (2026-10-02)
- Done: phone removed (user won't share it), email is mmateka89@gmail.com in JS card and noscript; repo renamed to l1pz/1000110.xyz; `.gitattributes` forces LF (CRLF checkouts broke Biome on Windows). Noscript is still hand-written: generating it at build time stays an open idea.
- Next: Phase 1, "Decide: bring back ASCII borders on cards?" (needs a user decision).

### Session 3b (2026-10-02)
- Done: fake `phone: +36 xx xxx xxxx` restored in JS card and noscript; the 2 extra blank rows removed; `npm run check` passes. Not yet eyeballed in `npm run dev`.
- Next: Phase 1, "Decide: bring back ASCII borders on cards?" (needs a user decision).

### Session 4 (2026-10-02)
- Done: border styles as data (`src/borders.ts`), home cards in `src/cards.ts`, tests for all styles; rounded hardcoded; noscript cards carry the same frame. Toggle was built and removed.
- Next: Phase 1 binary footer decode animation (first unchecked).
- Also done: DejaVu Sans Mono replaces Space Mono (fixes unicode borders); `fonts/` moved to `public/fonts/` (was 404 in prod); one constant card gap (`gap: 1em 2ch`). Unifont tried and rejected.

### Session 4b (2026-10-02)
- Done: `<noscript>` cards are generated from `src/cards.ts` by `plugins/noscript-cards.js` (build and dev); 128 hand-written lines gone; build test covers it. Restart a running `npm run dev` to load the plugin.
- Next: Phase 2, "Markdown loader + frontmatter" (first unchecked; needs a plan shown in the terminal first).

### Session 5 (2026-10-02)
- Done: blog loader in `src/features/blog/` (`frontmatter.ts` hand-written parser, `posts.ts` bundles `posts/*.md` via glob, `getPosts()` newest first, `getPost(slug)`); sample post and tests. `npm run check` passes.
- Next: Phase 2, "Blog card on home grid" (needs the feature module `card()` export and a plan shown in the terminal first).

### Session 6b (2026-10-09)
- Done: `Card.drawFooter` (branch `feat/card-footer`); aboutme/projects/contact use it with byte-identical output. `experiments.ts` still uses `drawBinaryTextCentered` (28-char message, 7 lines): not a standard footer, left alone.
- Next: the `art` card has no footer yet (one `drawFooter` line when wanted).

### Session 6 (2026-10-09)
- Done: blog card (`src/features/blog/index.ts`, `buildBlogCard`): newest 5 posts, each row links to `/blog/#slug`; wired into `buildHomeCards` (so noscript follows), `index.html`, typewriter art, `drawFooter` binary footer, tests. Not yet eyeballed in `npm run dev`.
- Next: Phase 2, "TUI reading view with progress meter" (the `/blog/` page; needs `page` on the feature object, a new HTML page in `vite.config.js`, and a plan shown in the terminal first).

### Session 7 (2026-10-09)
- Done: `/blog/` reader (branch `feat/blog-reader`): list as `ls -l`, post view with man-page header, boxed code, status line with progress meter, vim-style keys; `markdown.ts` + `page.ts` with tests. `markdown-demo.md` is a sample post to delete before real posts. Not yet eyeballed by the user.
- Next: Phase 2, "RSS feed script". Possible follow-ups: build-time `<noscript>` posts, table-of-contents widget card.

### Session 9 (2026-10-10)
- Done: DESIGN.md approved and merged (PR #13); design system step 1 (branch `feat/shell`): `src/core/{html,shell}.ts`, `styles/shell.css`, blog refactored onto them with no visual change (checked in the browser). PR #12 (home charm) is still open and waits for the rebase in step 3; it has its own `styles/status.css` which must be folded into `shell.css`.
- Next: step 2, phone rules.

### Session 8 (2026-10-09)
- Done: home page charm 1-3 (branch `feat/home-charm`): card color styles, tmux-style status bar with clock, h/j/k/l + number-key navigation with a yellow focus border. Ideas 4-6 stay parked in this file. Not yet eyeballed by the user.
- Next: user looks at the home page; then Phase 2 "RSS feed script" or the parked home ideas (command prompt first).

### Session 9b (2026-10-10)
- Done: whole redesign in PR #14: #12 merged into the branch (and closed), phone rules, home page on the shell (`src/home.ts`, command-style card titles, whoami block), blog rows are full-width links, DESIGN.md/AGENTS.md/DECISIONS.md updated. Checked in the browser at desktop, 390px and 360px (narrow iframes; real phones and `pointer: coarse` still untested).
- Next: user looks on a real phone; then Phase 2 "RSS feed script" or the parked home ideas (command prompt first).

### Session 11 (2026-10-10)
- Done (branch `feat/rss`): `/feed.xml` (RSS 2.0, full content) built by `plugins/rss-feed.js` from `src/features/blog/feed.ts`; served in dev too; discovery `<link>` in the head of home and blog; tests added. `posts/` is empty, so the feed has no items yet.
- Next: Phase 3 tools, or the parked home ideas (command prompt first). The generated post index for the home page was left out on purpose (DECISIONS.md still says to replace the glob import when the blog grows).

### Session 10 (2026-10-10)
- Done (branch `feat/consistency`): every page (home, blog index/post/not found, experiments, fluid dynamics) goes through `renderPage` and one status line; home is a session; cards retired from pages (engine kept); guard tests added. Checked in the browser at desktop and 360px; real phones still untested.
- Next: user looks; then Phase 2 "RSS feed script" (can also generate the post index the home page needs later) or the parked home ideas (command prompt first).
- Also: the two sample posts (`hello-world`, `markdown-demo`) are removed; `posts/` keeps a `.gitkeep`, so the blog and the home blog section show "(nothing here yet)" until the first real post. Tests no longer depend on bundled posts (`blog-rows.test.ts` uses fixtures). Markdown features are still shown in `tests/blog-markdown.test.ts`.

### Session 12 (2026-10-10)
- Done (branch `docs/tools-list`): `TOOLS.md` catalogue (public browser tools, private backend tools, YouTube to MP3 as a private tool) and Phase 3 task 0: the tools registry (`src/features/tools/`, `/tools/`, folder-per-tool with lazy chunks, `access` field) with the case converter as the first tool; status line is now `1:home 2:blog 3:tools 4:exp`. `npm run check` passes; looked at in the browser at desktop, 360 and 390 wide (iframes). Real phone untested.
- Next: `TOOLS.md` first ten, item 1 (encode/decode playground); private tools wait for Phase 6a.

### Session 13 (2026-10-11)
- Done (branch `feat/encode-decode`): encode/decode tool (`tools/encode/`: binary, hex, base64, rot13, url, html, morse; variants, swap button, hex fallback for non-UTF-8); `statusLine` and `buttonRow` added to `ui.ts`. `npm run check` passes; used in the browser, no overflow at 360 and 390 (iframes). Real phone untested.
- Next: `TOOLS.md` first ten, item 2 (hash generator).

### Session 14 (2026-10-17)
- Done (branch `feat/tools-a-generators`): tools now built in implementation batches (DECISIONS.md, TASKS.md, TOOLS.md regrouped); batch A: `hash` (MD5 written by hand, SHA via Web Crypto, HMAC), `password` (password + passphrase, entropy meter, word list), `uuid` (UUID v4/v7, ULID, NanoID); shared `random.ts`, `lineInput`/`numberInput`/`toggleButton` in `ui.ts`. `npm run check` passes (206 tests).
- Not done: looked at in the browser (the Chrome extension was not connected), so 360/390 layout is unchecked. Next: batch B (JSON formatter, text counter, diff checker, regex tester).

### Session 15 (2026-10-17)
- Done (branch `feat/tools-b-text-data`): batch B as four tools: `json` (format/minify/validate, sort keys; own `findError` scanner gives line and column because current V8 reports no position), `count`, `diff` (LCS line diff, 4M-cell cap), `regex` (flags, highlighted matches, groups, token-by-token `explain`). `npm run check` passes (242 tests).
- Not done: looked at in the browser (Chrome extension not connected), so 360/390 layout is unchecked. Regex runs on the main thread: a catastrophic pattern like `(a+)+$` can freeze the tab (worker with timeout is a possible follow-up). Next: batch C.

### Session 16 (2026-10-17)
- Done (branch `feat/tools-c-calculators`): batch C as three tools: `cidr` (IPv4 + IPv6 via BigInt, /31 and /32 rules, special range names), `time` (unix s/ms or date string to UTC, local and IANA zones via Intl, DST tested), `color` (HEX/RGB/HSL, WCAG contrast; ratio is floored so a failing 4.499 never shows as 4.50). `.stats.wide` stacks label over value for long rows. `npm run check` passes (273 tests).
- Not done: looked at in the browser, so 360/390 layout is unchecked. IPv6 with embedded IPv4 (`::ffff:1.2.3.4`) and dotted netmasks (`/255.255.255.0`) are not parsed. Next: image to ASCII / dither studio.

### Session 17 (2026-10-17)
- Done (branch `feat/tools-u1`, stacked on `docs/tool-upgrades`): U1 plumbing. `state.ts` (hash query `#json?i=..&m=..`, remembered options in localStorage, text never stored, "copy link"), `files.ts` + paste button and text-file drop in `textInput`, "send to" (`pipe: true` in meta, sessionStorage handoff), `palette.ts` (`/` or Ctrl-K, plus a "search tools" button on the list). All 12 tools wired. `npm run check` passes (300 tests). Used in the browser at desktop and in 360 / 390 iframes: no overflow.
- Not done: U1b (highlighting) is its own branch and session, as decided. Hash tool does not take dropped files yet (U2). Next: U1b, or U2.

### Session 18 (2026-10-18)
- Done (branch `feat/theme-picker`): color themes (gruvbox dark / light, amber crt, green phosphor, solarized dark, nord) with `auto` (follows the OS) as the default; `/theme/` page, `◐` status link, `t` key, no-flash boot script in every head; tests for contrast per theme, CSS vs list, the boot script and the saved choice. Used in the browser: switching, saved across pages, 360 / 390 iframes with no overflow (status line checked with the touch rules injected).
- Not done: real phone and `pointer: coarse` untested; `<meta name="color-scheme">` and tool example colors (Gruvbox hex as data in the color tool) unchanged. Next: U1b (highlighting; its token colors must use the theme variables so they follow every theme), or U2.
