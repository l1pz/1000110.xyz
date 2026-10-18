# Design system: 1000110.xyz

STATUS: IMPLEMENTED 2026-10-10 (shell PR #14, consistency PR). This is the source of truth for how every page looks and behaves. Code: `src/core/` (site map, frame, status line, keys), `styles/shell.css`, `styles/theme.css`.

Every page is a terminal session. Pages share one frame and serve their own content inside it. Phones come first: most visitors arrive on one.

## 1. The grid unit: the character cell
- One font (DejaVu Sans Mono), one size, one character cell. Widths are in `ch`, heights in lines. Hierarchy comes from color and markers (`#`, `$`), never from font size or weight.
- A phone shows about 40 columns (375px / 8.4px). **40 columns is the design width.** Desktop adds space around it, never a different layout language.
- The reading column is `min(72ch, 100%)` with a 1.5ch gutter.
- Small phones: the font size shrinks below ~400px wide so 44 columns (41 of content plus gutters) always fit. Only code boxes and wide art may scroll sideways.

## 2. Tokens (all in `styles/theme.css`, never raw hex elsewhere)
| Role | Variable | Used for |
|------|----------|----------|
| text | `--fg` | body text |
| secondary | `--gray` | dim text, borders, secrets, crumbs, dates, the `$` of a prompt |
| accent / title | `--yellow` | page titles, headings, the current window, prompt commands |
| structure | `--aqua` | links, h2, art accents |
| prompt / ok | `--green` | prompt lines, h3 |
| visited | `--purple` | visited links, art accent |
| error | `--red` | errors |
| surface | `--bg`, `--bg-soft` | page background, the status line and inline code |

Spacing: prose and listings use a 1.6 line height; ASCII art uses 1.0 (tight, so it holds its shape). Blocks are separated by one blank line.

### 2a. Built-in browser controls (check this whenever a new native control appears)
Native widgets bring their own look (light or blue, rounded, wrong font) and must be brought onto the theme. Rule: **before shipping any new input type or built-in widget, look at it in `npm run dev` and make it match, using theme variables only.** Already done in `styles/theme.css`:
- `color-scheme: dark` darkens native parts we do not style (form controls, the textarea resize grip, date and color pickers, dropdown lists); `accent-color` (yellow) tints checkboxes, radios, ranges and progress bars; `caret-color` and `::selection` use the theme yellow.
- Scrollbars: `scrollbar-width: thin` and `scrollbar-color` (gray thumb on the page background) on everything, so page, text boxes and code blocks match.
- Browser autofill is repainted with `:-webkit-autofill` so inputs stay on `--bg-soft`.
- Number inputs: native spinner arrows are hidden (`styles/tools.css`) and `numberInput` in `src/features/tools/ui.ts` draws `-` and `+` buttons instead (same look and 44px tap targets as every button).
Still to handle when they first appear: `<select>` (prefer a `modePicker` button row; if a real select is needed, style it like `.tool input`), date, time and color pickers (prefer our own text field plus a parser), checkboxes (prefer `toggleButton`), file inputs (use drop zones and a `button`), `<details>`, `<dialog>` and `<progress>` (draw the meter as text, like the status line). Prefer a TUI-style widget made from our buttons over styling a native one; if you must keep the native one, add its rule here.

### 2b. Color themes
The nine variables in `styles/theme.css` are the whole palette, so a theme is one `[data-theme="<id>"]` block that sets them all (Gruvbox Dark is the `:root` default and also answers to its own id, so a row can preview it). Rules:
- **Raw hex lives only in `theme.css`.** Everything else uses the variables; a test fails on a hex value in any other stylesheet. A canvas or script that needs a color reads it with `getComputedStyle(...).getPropertyValue("--name")`.
- A light theme also sets `color-scheme: light`, so native controls (2a) follow.
- Every theme must keep text readable (tested): `--fg` on `--bg` at least 7, `--fg` and `--yellow` on `--bg-soft` at least 4.5, `--yellow`, `--aqua`, `--green`, `--purple` on `--bg` at least 4.5, `--gray` and `--red` on `--bg` at least 3.5 (Gruvbox Dark's gray, 4.0, sets that floor).
- Adding a theme = a CSS block plus one entry in `THEMES` in `src/core/theme.ts`; tests check the two agree.
- The choice is `localStorage["theme"]` (a theme id; absent means `auto`). `auto` follows the system: Gruvbox Light when it prefers light, otherwise Gruvbox Dark. `/theme/` (window `5:theme`) lists the themes (each row previews its own colors through a scoped `data-theme`), and `t` cycles. A blocking inline script (`plugins/theme-boot.js`, injected in every page head) sets the attribute before first paint, so there is no flash. Without JavaScript the site is Gruvbox Dark.

### 2c. Syntax highlighting
Code colors come from `styles/highlight.css`, theme variables only: keys and classes aqua, strings green, numbers and literals purple, keywords red, escapes, quantifiers and function names yellow, comments and punctuation gray, diff add green and del red. Editable fields keep the character grid: the colored layer has the same font, padding and wrapping as the textarea behind it. Check new highlighted fields on a phone at 360 and 390.

## 3. The frame (every page, no exceptions)
`renderPage({ page, command, body, date, ... })` in `src/core/shell.ts` outputs, in this fixed order:
1. **Crumbs**: `1000110.xyz / blog / hello-world`, gray, each part but the last a link.
2. **Man header**: `NAME(1)    section    date`, one dashed rule under it. The date is the page's own (a post's date) or today.
3. **Prompt line**: `$ command`, the `$` dim, the command in yellow-green. Every block of content is the output of a command.
4. **Body**: the page's own content (it may contain more prompt lines).
5. **Secret** (optional): a hidden dim binary message.
6. **End prompt**: `$ █` with the blinking cursor (static under reduced motion).

Page code only writes the body. The pages are listed once in `src/core/site.ts`; adding a page means one entry there plus its HTML file in `vite.config.js` (a test fails if they disagree).

## 4. The status line (every page)
Fixed at the bottom, same on every page:
- Left: the site windows from the site map, `1:home 2:blog 3:tools 4:exp 5:theme`, as links. The current page is highlighted yellow with `*`; a child page keeps its parent's window. This is the navigation on phones.
- Right: a clock and the scroll progress, `23:41 [████░░░░] 42%`. Under 600px the clock hides, under 500px the bar hides, under 420px the percentage hides too.
- `5:theme` is the last window (the theme page, 2b). Five windows fill the bar on a phone, so under 420px the percentage on the right is hidden too (the clock hides under 600px, the bar under 500px) and the touch padding of a window is 0.5ch; checked at 320, 360 and 390.
- It clears the iPhone home indicator (`env(safe-area-inset-bottom)`), and on touch screens each window is at least 44px tall.

## 5. Keys (every page; only a bonus, everything works by tap)
`1`-`9` go to site window N, `j`/`k` scroll, `g`/`G` top and bottom, `t` next color theme, `b` or Esc go up one level (a blog post goes back to the list, otherwise the parent page or home). Space, PageUp, PageDown and the arrows scroll natively.

## 6. Content patterns (what a page puts in the body)
| pattern | pages | looks like |
|---------|-------|------------|
| session | home | one command per section: `$ whoami`, `$ cat portrait.txt`, `$ ls ~/blog`, ... with ASCII art in tight blocks |
| listing | blog index, experiments, the lists on the home page | rows of one link each (`ls -l` style); the row is the tap target (44px on touch) |
| prose | a blog post | left-aligned column, headings with a dim `#` marker, boxed code, dimmed quotes |
| tool | an experiment, a page of `/tools/` | the frame, with the canvas or form as the body; tools use the shared form bits of `styles/tools.css` (bordered inputs, outlined buttons, the active mode in yellow) |
| later | gallery, oracle | gallery: listing of albums, a post-like viewer; oracle: a feed inside the frame |
Cards (the fixed 41 x 32 character tile, `src/card.ts`) are not a page pattern. The engine stays as a toolkit for future widgets.

## 7. Hidden messages (easter eggs)
Dim binary text, 4 bytes (35 columns) per line, `aria-hidden`, no hint that it is there, no decode, no animation. A page may have one in the frame's `secret` slot (a blog post sets `secret:` in its frontmatter, at most 32 characters); the home page has one under the portrait, projects and contact sections.

## 8. Phone rules (apply to every pattern)
- One column, no page-level horizontal scroll (code boxes and wide art may scroll inside their own block).
- Tap targets at least 44px tall on touch screens (`pointer: coarse`): status line windows, crumbs, listing rows.
- No feature may need hover or a keyboard.
- No motion beyond the cursor blink; honor `prefers-reduced-motion`.
- Check every UI change at 360px and 390px wide, not only on desktop.

## 9. How to add a page
1. Add an entry to `pages` in `src/core/site.ts` (child pages set `parent` and get no window).
2. Create the HTML file (copy `experiments/index.html`: `body class="shell"`, a `<main class="page">`, `<footer id="status">`, a `<noscript>` note, `viewport-fit=cover`) and list it in `vite.config.js`.
3. Build the body and call `renderPage` (or `mountPage` for a single block); then `bootPage`.
4. Test the renderer with `assertShell`. `npm run check` fails if a step is missing.

## 10. History and rejected ideas
- The home page used to be a grid of 41 x 32 cards. Beside the blog it felt like a different site (centered text, equal tiles, no prompt), so it became a session; the card engine, its colors and its tests stayed.
- The man header date: a page's own date where it has one, today otherwise (decided 2026-10-10). A blinking clock colon was declined.
- Still open: do the stacked sections of the home page feel too long on a phone? Should art and listings go two columns on very wide screens?
