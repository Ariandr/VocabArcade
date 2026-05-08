# Vocab Arcade

A browser-only vocabulary practice app for imported study sets. It runs as a static Vite + React app, stores sets in your browser, and can be deployed to GitHub Pages.

This project is an independent vocabulary practice tool. It is intended for practicing study data that you are allowed to access.

## Features

- Import study sets with a browser bookmarklet, paste box, CSV, or TSV.
- Keep all sets and progress in browser `localStorage`.
- Practice with Set Review, Flashcards, Learn, Test, Match, Blocks, and Blast.
- No backend, proxy, local companion service, or account system.
- Static build suitable for GitHub Pages.

## Local Development

```bash
npm install
npm run dev
```

Then open the URL printed by Vite, usually `http://127.0.0.1:5173/`.

## Build

```bash
npm run build
```

The static output is written to `dist/`.

## Tests

```bash
npm test
```

## Bookmarklet Import

The app generates a bookmarklet from the import screen. Save it to your bookmarks bar, open a study set page that you can access, then click the bookmarklet. It extracts term-definition study data from the current page and sends it back to the app with `postMessage`.

Normal webpage JavaScript cannot read another site’s logged-in pages or cookies, so the bookmarklet runs only after you explicitly click it on the study page.
