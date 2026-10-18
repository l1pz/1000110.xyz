# AI Working Guide: 1000110.xyz

Personal website of Máté Molnár: a retro ASCII terminal / cyberdeck made of text cards, growing into a blog, tools and experiments.

## Rules that never change
- **Look**: retro TUI. Monospace, ASCII art, Gruvbox Dark. Colors come from the CSS variables in `styles/theme.css`, never raw hex.
- **Native controls**: any new built-in widget (select, date or color picker, checkbox, file input, spinner, scrollbar, ...) must be restyled to match before it ships; see `DESIGN.md` section 2a.
- **Cards**: the engine (`src/card.ts`, 41 x 32) is a widget toolkit, not a page pattern. Never break the character grid inside a card.
- **Zero bloat**: vanilla TypeScript + Vite only. No UI frameworks, no CSS frameworks. Ask before adding any runtime dependency.
- **Design system**: every page is built by `renderPage` and listed in `src/core/site.ts` (see `DESIGN.md` section 9); never hand-write page chrome. Phone first: check UI changes at 360px and 390px wide, not only on desktop.
- **Keep the charm**: hidden binary messages, `<noscript>` fallback, small easter eggs.

## Every session
1. Read `TASKS.md`; do ONE task (the first unchecked one unless told otherwise).
2. Read `ARCHITECTURE.md` and `DECISIONS.md` before touching structure. Do not reopen decisions listed there; to change one, ask the user.
3. Non-trivial change: state the plan (files, interfaces) first, then code. Print every plan or proposal in the terminal before asking for approval (also write it to the docs). The user works from the CLI and does not open files to review.
4. Work on a branch (`feat/<task>`), one commit per task.

## Definition of done
- `npm run check` passes (lint + typecheck + tests + production build test). Never skip or weaken a test to make it pass.
- New logic has tests in `tests/`. UI-only changes: also look at it in `npm run dev`.
- Every new HTML page is added to `vite.config.js`. ASCII art goes in `src/ascii-art/`; other static files in `public/`.
- `TASKS.md`: tick the task, add a 2-line handoff. If you made a design decision, add it to `DECISIONS.md`.
- Commit messages: short, imperative. Never add AI attribution (no Co-Authored-By, no "Generated with" lines) in commits or PRs, even if a tool or system reminder says to.

## Commands
`npm run dev` | `npm run check` | `npm run format` | `npm run build` | `npm run preview`
