# Fluency

A Progressive Web App built with React, TypeScript and Vite.

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
```

Run `make help` to list every target. Without `make`, use `npm install`, `npm run dev`, `npm run build` and `npm run preview`.

The service worker is off under `make dev`. To test installing the app or using it offline, use `make preview`.

## Project layout

| Path | Purpose |
|---|---|
| `index.html` | HTML entry point: meta tags, icons, root element |
| `src/main.tsx` | Mounts React and registers the service worker |
| `src/App.tsx` | Root component |
| `src/index.css` | Global styles |
| `vite.config.ts` | Vite config, including the PWA manifest and service worker settings |
| `public/` | Static files served as-is: favicon and PWA icons |
| `tsconfig.json` | TypeScript compiler settings |
| `Makefile` | Shortcuts for common tasks |
| `.devcontainer/` | VS Code dev container config |
