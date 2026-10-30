# Architecture: 1000110.xyz

## Core idea
Every page is a terminal session built by one shared page frame (see `DESIGN.md`): crumbs, a man-page header, `$ command` prompt lines with their output, an end prompt with a blinking cursor, and a fixed status line. The site is a list of pages (`src/core/site.ts`); each page only writes its own body. The card engine (a fixed grid of characters) is kept as a tested widget toolkit, but no page uses cards right now.

## Files
```
index.html, blog/index.html, experiments/**/index.html   pages (all listed in vite.config.js and in src/core/site.ts)
src/core/site.ts                        the site map: pages as data (id, path, window name, section, pattern, parent, note), crumbTrail, windows
src/core/shell.ts                       the page frame `renderPage` and its parts: crumbs, manHeader, promptLine, secretBlock, endPrompt, isoDate
src/core/statusline.ts                  the shared status line: site windows, clock, scroll progress; mountStatusLine
src/core/keys.ts                        the shared keys (1-9 windows, j/k, g/G, b/Esc) and bindKeys
src/core/theme.ts                       color themes: the list, the saved choice (`auto` or an id), apply to <html>, cycle (see DESIGN.md 2b)
src/themes.ts, src/themes-page.ts       the /theme/ page (rows with swatches); entry
plugins/theme-boot.js                   build/dev plugin: injects the blocking script that sets the theme before first paint
src/core/boot.ts                        bootPage (status line + keys) and mountPage (frame around one block, for tools)
src/core/html.ts, binary.ts             escapeHtml; binaryLines (hidden messages)
src/home.ts, src/index.ts               the home page (a session of commands); entry
src/experiments-page.ts, src/experiments.ts   the experiments listing; entry
src/features/blog/                      blog: loader, markdown, page (index, post, not found), rows (see below)
src/features/tools/                     tools: registry, page (list, tool, not found), ui helpers, `tools/<id>/{meta,index}.ts` (see below)
src/blog.ts, src/tools.ts               blog and tools entries
plugins/noscript-home.js                build/dev plugin: fills the <noscript> block of index.html with renderHome
src/card.ts, borders.ts, ascii.ts       card engine (toolkit, unused by pages for now), border styles, bundled ASCII art
src/ascii-art/                          ASCII art (.ascii), bundled at build time
styles/                                 reset, theme (Gruvbox variables, fluid font), shell (frame, status line, listing rows, art), blog (prose), card (engine colors), experiment
public/fonts/                           self-hosted fonts (DejaVu Sans Mono + JGS pixel fonts), copied as-is to dist/fonts
tests/                                  vitest; tests/helpers/shell.ts has assertShell; build.test.ts is the production-build guard
```

## The page frame and the site map
- `renderPage({ page, command, body, date, trail?, name?, secret? })` outputs, always in this order: crumbs, man header, `$ command`, body, optional secret, end prompt. Page code only writes `body`; a page cannot leave a part out.
- `pages` in `site.ts` is the single list of pages. The status line windows (`1:home 2:blog 3:tools 4:exp 5:theme`), crumbs and man header all come from it. A new page = one entry there plus its HTML file in `vite.config.js`; `tests/pages.test.ts` fails if the two disagree, and `tests/build.test.ts` checks every built page has `body.shell`, a status line mount, the phone viewport and a `<noscript>`.
- Tests of every page renderer call `assertShell(html)` (parts present, in order, end prompt last).
- Hidden messages: `secretBlock(text)` is a dim, aria-hidden binary block (4 bytes per line); pass `secret` to `renderPage` or call it per section. Posts can set `secret:` in their frontmatter (at most 32 characters).

## Status line and keys (every page)
- `statusline.ts`: left, the site windows as links (current page highlighted with `*`, a child page keeps its parent's window); right, `HH:MM [████░░░░] 42%`. CSS hides the clock under 600px and the bar under 500px.
- `keys.ts`: `1`-`9` go to site window N, `j`/`k` scroll, `g`/`G` top and bottom, `t` next color theme, `b`/Esc go up (a blog post goes back to the list; otherwise the parent page, or home). Space, PageUp/PageDown and the arrows scroll natively.

## Phone rules in code
- `--font-size` in `theme.css` is `min(14px, (100vw - 16px) / 26.49)`, so 44 columns (41 of content plus the page gutters) always fit a phone.
- Status line: `viewport-fit=cover` plus `env(safe-area-inset-bottom)` padding; on touch screens (`pointer: coarse`) windows, crumbs and listing rows are at least 44px tall.
- Art blocks keep tight spacing and scroll sideways rather than overflow.

## Home page (`src/home.ts`)
The "session" pattern: `whoami`, `cat portrait.txt`, `ls ~/blog` (newest 5 posts, same rows as the blog index), `ls projects/`, `cat contact.txt`, `echo "l'art pour l'art"` (a random art piece, picked by `initAscii()`). Hidden binary messages sit under the portrait, projects and contact sections. `plugins/noscript-home.js` renders the same `renderHome` into `<noscript>` at build time (the age and the art piece are fixed per build); never edit that copy by hand.

## Feature modules (APPROVED 2026-10-02)
Each feature (blog, tools, gallery, oracle) is a folder `src/features/<name>/` exporting one object:
```ts
export default {
  id: "blog",
  page: { path: "/blog/", mount(el) }   // the full-page view
}
```
Features never import each other; shared code goes in `src/core/`. This keeps each AI session inside one folder. (A feature may also offer a card widget later, using the card engine.)

### Blog (`src/features/blog/`)
- `frontmatter.ts` (pure parser/validator: `parseFrontmatter`, `parsePost`), `posts.ts` (`loadPosts`, `getPosts()` newest first, `getPost(slug)`), `posts/*.md` (title, date `YYYY-MM-DD`, optional `tags: [a, b]`, `slug`, `secret`). Bad frontmatter or a duplicate slug throws at load time.
- `rows.ts`: the `ls -l`-style rows, shared by the blog index and the home page. Each row is one link.
- `markdown.ts` (pure): Markdown subset to HTML. Headings `#`-`###` (marker kept, dimmed), paragraphs, `-`/`1.` lists, `>` quotes, fenced code drawn as a text box, `---`, inline `code`/`**bold**`/`*italic*`/`[link](url)`. All text is escaped first; only http(s), mailto, `/` and `#` links are made clickable.
- `page.ts`: renderers (`renderIndex`, `renderPost`, `renderNotFound`, all through `renderPage`) and `mount(el)`. Routing by hash: `/blog/` is the list, `/blog/#<slug>` a post, an unknown slug a "no such file" page. No router, no per-post HTML files.
- No-JS: the page only shows a "needs javascript" note. Rendering posts into `<noscript>` at build time is a possible follow-up.
- Known cost: the home page imports `posts.ts`, so every post body is in the home bundle. Fine for a few posts; replace with a generated post index (the RSS task will produce one) when the blog grows.

### Tools (`src/features/tools/`, catalogue and build order in `TOOLS.md`)
- One page, `/tools/`, with hash routing like the blog: `/tools/` is the list (`ls tools/`, grouped by category), `/tools/#<id>` one tool inside the page frame, an unknown id a `command not found` page. A tool never needs an HTML file, a `vite.config.js` line or a `site.ts` entry.
- A tool is a folder `tools/<id>/`: `meta.ts` exports `meta` (`id` = folder name, `title`, `category`, `summary`, optional `access`, `secret`) and is loaded eagerly; `index.ts` exports `mount(el)` (may be async, may return a `cleanup()`) and is loaded only when the tool is opened, so each tool is its own chunk. Pure logic sits in its own file in the folder (e.g. `case/convert.ts`) so tests call it directly.
- `registry.ts`: `loadTools` validates every `meta` (unique id, id = folder, known category, `secret` at most 32 characters) and throws with the file path; `publicTools`/`getPublicTool` hide `access: "private"` tools (backend tools for the owner behind Pocket ID, listed only in the admin later); `loadTool(id)` imports the code.
- `page.ts` renders through `renderPage`, shows `loading...` while a chunk loads, and calls the previous tool's `cleanup()` on every route change. `ui.ts` has the shared form bits (`textInput` with paste and text-file drop, `outputBox` with copy and "send to", `modePicker`, `toolState` and `linkButton`), styled in `styles/tools.css`. `state.ts` (pure) holds the hash query, remembered options and the "send to" handoff; `files.ts` the drop rules; `palette.ts` the `/` / Ctrl-K search (`rankTools` is pure).

- `tools/sc2bp/` is the one tool that needs the backend and is still listed. Pure, tested logic: `parse.ts` (SoundCloud title to artists, title, mix), `match.ts` (scores Beatport candidates, verdict `match` / `maybe` / `none`), `review.ts` (rows, picks, summary, missing list), `api.ts` (typed client for `/api/sc2bp/*`, `AuthError` with the login address, `loginUrl`). `index.ts` is the UI (results are buttons, no native select); `fixtures.ts` is a fake server used only by `npm run dev`. The service it talks to lives in `sc2bp/` (FastAPI, `yt-dlp`, Beatport; deployed by hand to `/opt/stacks/sc2bp`); see DECISIONS.md 2026-10-30.

### Syntax highlighting (`src/core/highlight/`)
- `index.ts`: `highlight(lang, text)` (async, escaped HTML), `highlightNow` (json, sync), `canonicalLang` (`js`, `html`, `sh` ... to an id), `splitHtmlLines`. `json.ts` is a hand-written tokenizer; `generic.ts` is the only file that imports `highlight.js` (javascript, typescript, css, xml, markdown, bash) and is loaded lazily. Classes: our `tok-*` and `hljs-*`, colored in `styles/highlight.css` from theme variables.
- Regex and diff colorers sit in their tool folders (`regex/highlight.ts` reuses `explain()`, whose steps now carry a `kind`; `diff/highlight.ts`).
- `ui.ts`: `textInput(..., { colorer })` draws the overlay, `outputBox(..., { colorer })` a colored `<pre>`. Blog: `blog/code.ts` colors `pre.code[data-lang]` blocks after render.

## Card engine (`src/card.ts`, kept as a toolkit)
Pure logic, fully tested (`tests/card.test.ts`). The only DOM touch is `render()`. Cards are for future widgets (a table of contents, the Oracle, a clock), not for pages.
- `new Card(cols, rows, title, draw, border?)`: title on row 1, drawing starts at row 3. A title starting with `$ ` gets a dim prompt.
- `drawTextCentered(text, link?, style?)`, `drawAsciiArtCentered(name, style?)`, `drawBinaryTextCentered(text, style?)`, `emptyLine(n)`: each draws at the current row and moves down. `link = { href, label? }`.
- `drawFooter(text)`: the hidden binary message, 4 lines ending one blank row above the bottom row, padded to 16 characters.
- Colors: every cell can carry a `CardStyle` (`title`, `border`, `dim`, `aqua`, `green`, `yellow`, `purple`, `red`); `toHtml()` wraps runs in `<span class="c-NAME">` (colors in `styles/card.css`); `linkTitle(href)` makes the title a link.
- Drawing outside the grid throws `RangeError`. `toString()` is plain text, `toHtml()` escaped HTML, `render(el)` mounts a `<pre>`. An optional `border` (from `src/borders.ts`) is drawn after the content and throws if content overlaps it.
