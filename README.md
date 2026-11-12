# Fluency

A sentence-drill app for intermediate and advanced language learners, built as a Progressive Web App with React, TypeScript and Vite. It shows a sentence in your language, you translate it into the language you're learning, and a spaced-repetition scheduler decides when you see it again. All data stays on your device, except that with LLM grading turned on, checking an answer sends the sentence, the reference translation, your answer and the deck's languages to the LLM provider you choose.

Current features: decks and cards you can create, edit and export (CSV per deck, JSON backup of everything), sample decks, a study loop with self-rating and skip, spaced-repetition scheduling, LLM grading and feedback (bring your own API key for an OpenAI-compatible provider such as OpenRouter), and offline use with an update prompt.

For how it works, see [doc/design.md](doc/design.md).

## Requirements

- Node.js 24+ and npm
- `make` (optional; every target wraps an npm script)

Or open the repo in VS Code and choose **Dev Containers: Reopen in Container**. This needs Docker and the Dev Containers extension.

## Build and run

```sh
make install   # install dependencies
make dev       # dev server at http://localhost:5173
make build     # typecheck and build to dist/
make preview   # build, then serve dist/ at http://localhost:4173
make test      # unit tests (vitest)
make eval      # grading evaluation against real models (paid; see doc/llm-grading.md)
```

Run `make help` to list every target. Without `make`, use `npm install`, `npm run dev`, `npm run build`, `npm run preview` and `npm test`.

The app works under any URL prefix, set at build time with `BASE_PATH` (default `/`). Pushes to `main` are deployed to GitHub Pages under `/<repo name>/` by `.github/workflows/deploy.yml`; set Settings → Pages → Source to "GitHub Actions" once. To try a prefixed build locally: `BASE_PATH=/fluency/ make preview`, then open `/fluency/`.

The service worker is off under `make dev`. To test installing the app or using it offline, use `make preview`.

## Project layout

| Path | Purpose |
|---|---|
| `doc/design.md` | Data model, screens, study loop and scheduling |
| `doc/llm-grading.md` | Design for LLM grading and feedback |
| `index.html` | HTML entry point: meta tags, icons, root element |
| `src/main.tsx` | Mounts React and seeds the sample decks on first run |
| `src/App.tsx` | Root component: picks the screen from the URL |
| `src/route.ts` | Hash router |
| `src/db.ts` | On-device storage (IndexedDB via Dexie): decks, cards, reviews, backup |
| `src/scheduler.ts` | Spaced-repetition scheduler (`scheduler.test.ts` has its tests) |
| `src/time.ts` | Time constants shared by the scheduler and the UI |
| `src/DeckList.tsx` | Home screen: decks and due counts |
| `src/Settings.tsx`, `src/llm.ts` | LLM settings, API key, chat request (`llm.test.ts`) |
| `src/Study.tsx`, `src/Feedback.tsx` | Study session screen and its feedback panel |
| `src/check.ts` | Study session logic: queue, LLM checks, writes, undo (`check.test.ts` has its tests) |
| `src/grader.ts` | LLM grading prompt and response validation (`grader.test.ts`) |
| `src/languages.ts`, `src/LanguagePicker.tsx` | Language tags and the language picker |
| `src/DeckView.tsx`, `src/CardForm.tsx` | Deck editor: add, edit and delete cards |
| `src/sampleDecks.ts` | Starter decks (Spanish, Chinese, Japanese) |
| `src/exportFile.ts` | CSV and JSON export |
| `src/UpdateToast.tsx`, `src/IosInstallPrompt.tsx` | Update/offline notice and iOS install hint |
| `src/index.css` | Global styles |
| `eval/` | Grading evaluation: test cases and the script `make eval` runs |
| `vite.config.ts` | Vite config, including the PWA manifest and service worker settings |
| `public/` | Static files served as-is: favicon and PWA icons |
| `tsconfig.json` | TypeScript compiler settings |
| `Makefile` | Shortcuts for common tasks |
| `.devcontainer/` | VS Code dev container config |
