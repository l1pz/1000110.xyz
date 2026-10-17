# Tools catalogue

The swiss army knife part of 1000110.xyz: many small tools, one simple site. This file is the idea list and the build order for Phase 3 in `TASKS.md`. Pick the first unchecked tool unless told otherwise.

## Principles
- **Public tools run in the browser.** Nothing is uploaded, and the site can say so. Heavy or network tools run on the backend and are **private**: behind Pocket ID, usable only by the owner, never listed publicly (see "Private tools").
- **Zero bloat.** Plain TypeScript first. Any runtime dependency needs the user's OK (see "Dependency gate").
- **One registry.** Every tool is a small module (`id`, `title`, `category`, `run`, optional UI). `/tools/` lists them like `ls tools/`; `site.ts` and `vite.config.js` stay small. Details are decided in the first task below, not here.
- **Same look.** `renderPage`, Gruvbox variables, phone first (check 360px and 390px), keyboard friendly. A `/` or `Ctrl-K` command palette comes almost free once the registry exists.
- **Shareable state.** Where it makes sense, tool input lives in the URL hash so a result can be linked.

Tags: **[T]** plain TypeScript, **[API]** browser API, **[LIB]** needs a library (approval), **[SRV]** needs a server or third party.

## Dependency gate
Ask the user before adding any browser dependency. Heavy ones (ffmpeg, PDF, HEIC) are meant to run on the backend as private tools instead, so they stay out of the public bundle.
- `ffmpeg.wasm` (only if a public in-browser audio/video tool is ever wanted): core is about 32 MB, lazy-load it; multi-threading needs cross-origin isolation headers (COOP/COEP) on nginx; phones have memory limits.
- A PDF library (merge, split, text to PDF), a HEIC decoder, a ZIP library, a YAML/TOML/XML parser, a SQL formatter, bcrypt.

## Not planned
- **YouTube to MP3 as a public tool.** Breaks YouTube's ToS and invites abuse and takedowns. It exists only as a private tool (below).
- Public server tools. Anything that needs the backend is private (below), so abuse is not a concern, but the tool still needs the Phase 6a backend first. Whois, ping, traceroute, SSL checker and currency rates are fine as private tools once it exists.

## Private tools (backend, after Phase 6a)
- Tools that need the server (ffmpeg, PDF, HEIC, whois, ping, SSL checks, ...) are protected by Pocket ID forward auth on `/api/` and `/admin/`, like the admin. Only the owner can call them. They share the Phase 6a service; no second backend.
- Their `meta` has `access: "private"` (public tools: `"public"`, the default). The public `/tools/` listing, the command palette and the home row show only public tools, so nothing private is advertised; private tools appear in the admin shell (`ls modules/tools/`).
- Same tool folder format as public tools: the `index.ts` calls `/api/tools/<id>`. Keep per-file size, timeout and concurrency caps anyway (the server also runs the Oracle).
- Not part of task 0: the registry only carries the `access` field and filters on it. No private tool exists until the backend does.

## How to add a tool
1. Make `src/features/tools/tools/<id>/meta.ts` (`export const meta: ToolMeta`) and `index.ts` (`export function mount(el)`); keep the logic in a pure file next to them.
2. Test the pure logic in `tests/`. The registry test already checks the meta and that `index.ts` exists.
3. Nothing else: no HTML file, no `site.ts` entry, no `vite.config.js` line.

## Private tool ideas (need the Phase 6a backend)
- [ ] YouTube / video URL to MP3 or MP4 with `yt-dlp` (+ ffmpeg) on the server, owner only (the owner already uses `yt-dlp` on the command line and accepts the ToS risk). Keep `yt-dlp` updatable without a site deploy (it breaks whenever YouTube changes); the server IP may get blocked.
- [ ] Audio/video convert, trim, GIF maker, extract audio from a file (ffmpeg)
- [ ] PDF merge, split, text to PDF; HEIC to JPG; ZIP
- [ ] Whois, ping, traceroute, SSL certificate checker, currency rates

## Registry design (task 0, implemented)
- **One page, hash routing, like the blog.** `/tools/` is the listing (`ls tools/`, grouped by category); `/tools/#<id>` is a tool inside the page frame. One new HTML file and one `site.ts` entry (`tools`, window `tools`, pattern `listing`); a tool never needs an HTML file, a `vite.config.js` line or a `site.ts` entry.
- **A tool is a folder** `src/features/tools/tools/<id>/` with `meta.ts` (loaded eagerly: `id`, `title`, `category`, `summary`, optional `access`, optional `secret`) and `index.ts` (loaded only when the tool is opened, so each tool is its own chunk). Extra files (helpers, a Web Worker, CSS) live in the same folder. `registry.ts` finds the metas with `import.meta.glob`, validates them (unique id, known category, `id` = folder name) and throws at load time like the blog loader.
- **`mount(el)` may be async** (the page shows `$ loading...` meanwhile) and may return a `cleanup()` that the page calls when you leave the tool.
- **Logic is pure and separate from the DOM** inside the tool folder (exported functions), so tests call them directly; `mount` only wires a form to them.
- **Shared bits** in `src/features/tools/ui.ts` (labelled textarea, output box with a copy button, button row) and `styles/tools.css`, colors from theme variables only, 44px tap targets, no hover needs.
- **Frame:** the tool page is `renderPage` with `$ <id>` as the command and crumbs `1000110.xyz / tools / <id>`; `b`/Esc goes back to the list.
- **Listing rows** are one link each: `id/  summary`, same row style as the blog. Home gets a `tools/` row under `ls projects/`.
- **First tool** proves the shape: the case converter (item 9, tiny); the text counter is still open.

## Encode / decode design (item 1, implemented)
- `tools/encode/codec.ts` (pure): `CODECS`, `run(id, direction, text, variant?)` returns `{ text, note? }`; failures throw `CodecError` and the page shows `error: ...` under the output instead of crashing.
- Variants (second row of buttons, first is the default): hex `lower | upper | compact`, base64 `standard | url-safe`, url `component | full url | form (+)`. Decoding is tolerant: Base64 takes both alphabets and no padding, hex takes `0x` and commas, binary takes one unbroken run.
- Byte codecs work on UTF-8. Bytes that are not valid UTF-8 (an image, gzip) are shown as hex with a note, not an error.
- "use output as input" moves the result into the input and flips encode/decode, so chains (URL, then Base64) are one tap each.
- No URL-hash state: the hash is already the tool route (`/tools/#encode`).
- Candidates for later: Base32 (TOTP secrets), Base58, Punycode, quoted-printable. Unicode escapes belong to "Escape / unescape strings".

## First ten (build order)
Cheap, popular, no dependency. Built in **implementation batches** grouped by shape: one branch and PR per batch, one commit and tests per tool. The batches are only a way of working; on the site every tool stays its own page, registry entry, route and chunk.
- [x] 0. Registry + `/tools/` listing + one tool page shape (done with the case converter as the first tool)
- [x] 1. Encode / decode playground: binary, hex, Base64, ROT13, URL, HTML entities, Morse [T]

**Batch A: generators and crypto** (Web Crypto, string out with a copy button)
- [x] 2. Hash generator: MD5, SHA-1/256/512, HMAC [API]
- [x] 3. Password and passphrase generator with entropy meter [API]
- [x] UUID / ULID / NanoID generator [API] (pulled in from "Encode / decode / crypto")

**Batch B: text and data** (text in, live result out; the regex explainer goes last and moves to its own session if it grows)
- [ ] 4. JSON formatter, validator, minifier [T]
- [ ] 9. Case converter [T] (done) and text counter (left)
- [ ] 10. Diff checker [T]
- [ ] 7. Regex tester with explanation [T]

**Batch C: calculators** (labelled fields in, result table out)
- [ ] 5. IP range / CIDR / subnet calculator, IPv4 and IPv6 [T]
- [ ] 6. Unix timestamp and time zone converter [API]
- [ ] 8. Color converter (HEX, RGB, HSL) and contrast checker [T]

Existing Phase 3 items map here: playground = 1, JSON formatter = 4, scratchpad = Writing / life below. Image to ASCII / dither studio and the fluid dynamics experiment stay in `TASKS.md`.

## Encode / decode / crypto
- [ ] Caesar / Vigenere / Atbash / XOR cipher tool [T]
- [ ] JWT decoder [T]
- [ ] UUID / ULID / NanoID generator [API] (batch A)
- [ ] AES encrypt/decrypt with a passphrase [API]
- [ ] Text to binary "hidden message" maker, tied to the binary footers [T]
- [ ] Bcrypt hash and verify [LIB]

## Text
- [ ] Lorem ipsum generator [T]
- [ ] Slugify, remove duplicate lines, sort lines, find and replace [T]
- [ ] Markdown preview (reuses the blog's `renderMarkdown`) [T]
- [ ] Text to ASCII art (figlet-style) [T]
- [ ] Unicode inspector and fancy-text generator [T]
- [ ] Zalgo text, emoji picker [T]

## Dev
- [ ] JSON to YAML / CSV [T], YAML / TOML / XML converters [LIB]
- [ ] SQL formatter [LIB]
- [ ] Cron expression explainer [T]
- [ ] Chmod calculator [T]
- [ ] URL parser and query-string builder [T]
- [ ] HTTP status code reference [T]
- [ ] `.gitignore` generator and git cheat sheet [T]
- [ ] Number base converter (bin, oct, dec, hex) [T]
- [ ] CSS tools: gradient, box-shadow, `clamp()` calculator [T]
- [ ] Escape / unescape strings [T]
- [ ] HTML / CSS / JS minifier [T]
- [ ] Color palette from an image [API]

## Network
- [ ] IPv4 <-> IPv6 and MAC address tools, OUI vendor lookup [T]
- [ ] Browser, screen and user agent info [API]
- [ ] "What is my IP" (nginx can return it) [SRV]
- [ ] DNS lookup via DNS-over-HTTPS [API]
- [ ] Port number reference [T]
- [ ] Wake-on-LAN packet builder [T]

## Images
- [ ] Image to ASCII / dither studio [API] (also in `TASKS.md` Phase 3)
- [ ] Compress, resize, convert PNG / JPG / WebP [API]
- [ ] Crop, rotate, flip [API]
- [ ] EXIF viewer and stripper [T]
- [ ] Favicon generator [API]
- [ ] QR code generator and reader [T] or [LIB]
- [ ] Image to Base64 [API]
- [ ] SVG optimizer, barcode generator, meme maker [T]
- [ ] HEIC to JPG [LIB]

## Audio / video (media lab, needs the dependency gate)
- [ ] Extract audio from a video file [LIB]
- [ ] Convert audio / video, trim, GIF maker [LIB]
- [ ] Audio recorder, tone generator, metronome, BPM tapper [API]
- [ ] Screen recorder, webcam and mic test [API]
- [ ] Text to speech [API]

## Files / documents
- [ ] CSV viewer and CSV to JSON [T]
- [ ] File hash (verify a download) [API]
- [ ] Hex viewer for any file [T]
- [ ] File-type sniffer (magic bytes) [T]
- [ ] PDF merge, split, rotate, image to PDF, text to PDF [LIB]
- [ ] ZIP / unzip in the browser [LIB]

## Math / units / time
- [ ] Unit converter, including data sizes and bits vs bytes [T]
- [ ] Calculator with history, percentage and tip [T]
- [ ] Programmer calculator (bit ops, two's complement) [T]
- [ ] Date difference, "days until", age, week number [T]
- [ ] Roman numerals, prime checker, number to words [T]
- [ ] Random number, dice, coin, picker wheel, team splitter [T]
- [ ] World clock, Pomodoro, stopwatch, countdown [T]
- [ ] Currency converter [SRV]

## Fun / charm
- [ ] Matrix rain, `cowsay`, fortune, fake BIOS boot screen [T]
- [ ] Typing speed test [T]
- [ ] Game of Life [T]
- [ ] ASCII table, Braille, semaphore, NATO phonetic [T]
- [ ] Pixel art editor, 8x8 font viewer [T]
- [ ] Hidden commands and easter eggs (Konami code) [T]

## Writing / life
- [ ] Scratchpad that autosaves to localStorage [T] (the Phase 3 scratchpad)
- [ ] Todo list, habit counter [T]
- [ ] Markdown notes with export [T]

## Research notes
- Competitors: IT-Tools (about 86 tools; categories Crypto, Converter, Web, Images & Videos, Development, Network, Math, Measurement, Text, Data), CyberChef (300+ chainable operations), DevToys (desktop), Omni Tools, DevUtils. No reliable traffic ranking was found; this list is based on their feature sets.
- ffmpeg.wasm tradeoffs (size, COOP/COEP headers, mobile memory, GPL codecs) are in the dependency gate above.
- Sources: alternativeto.net (CyberChef, DevToys, Omni Tools), linux-magazine.com IT-Tools article, shotstack.io ffmpeg.wasm guide, dev.to ffmpeg-in-the-browser posts.
