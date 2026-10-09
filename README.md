# Fluency

A sentence-drill app for intermediate and advanced language learners, built as a Progressive Web App with React, TypeScript and Vite. It shows a sentence in your language, you translate it into the language you're learning, and a spaced-repetition scheduler decides when you see it again. All data stays on your device.

Current features: decks and cards you can create, edit and export (CSV per deck, JSON backup of everything), sample decks, a study loop with self-rating and skip, spaced-repetition scheduling, and offline use with an update prompt.

For how it works, see [design.md](design.md).

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
```

Run `make help` to list every target. Without `make`, use `npm install`, `npm run dev`, `npm run build`, `npm run preview` and `npm test`.

The app works under any URL prefix, set at build time with `BASE_PATH` (default `/`). Pushes to `main` are deployed to GitHub Pages under `/<repo name>/` by `.github/workflows/deploy.yml`; set Settings → Pages → Source to "GitHub Actions" once. To try a prefixed build locally: `BASE_PATH=/fluency/ make preview`, then open `/fluency/`.

The service worker is off under `make dev`. To test installing the app or using it offline, use `make preview`.

## Project layout

| Path | Purpose |
|---|---|
| `design.md` | Data model, screens, study loop and scheduling |
| `index.html` | HTML entry point: meta tags, icons, root element |
| `src/main.tsx` | Mounts React and seeds the sample decks on first run |
| `src/App.tsx` | Root component: picks the screen from the URL |
| `src/route.ts` | Hash router |
| `src/db.ts` | On-device storage (IndexedDB via Dexie): decks, cards, reviews, backup |
| `src/scheduler.ts` | Spaced-repetition scheduler (`scheduler.test.ts` has its tests) |
| `src/time.ts` | Time constants shared by the scheduler and the UI |
| `src/DeckList.tsx` | Home screen: decks and due counts |
| `src/Study.tsx` | Study session |
| `src/DeckView.tsx`, `src/CardForm.tsx` | Deck editor: add, edit and delete cards |
| `src/sampleDecks.ts` | Starter decks (Spanish, Chinese, Japanese) |
| `src/exportFile.ts` | CSV and JSON export |
| `src/UpdateToast.tsx`, `src/IosInstallPrompt.tsx` | Update/offline notice and iOS install hint |
| `src/index.css` | Global styles |
| `vite.config.ts` | Vite config, including the PWA manifest and service worker settings |
| `public/` | Static files served as-is: favicon and PWA icons |
| `tsconfig.json` | TypeScript compiler settings |
| `Makefile` | Shortcuts for common tasks |
| `.devcontainer/` | VS Code dev container config |
