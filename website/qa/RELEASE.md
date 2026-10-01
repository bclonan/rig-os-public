# Website release checks

The October 1, 2026 local production build passed strict browser verification at `http://127.0.0.1:4337/`. Run `npm run verify` from `website` to repeat it. Set `QA_URL` to check another origin. The file-link crawl always checks the local `dist` directory.

- 14 checks passed. No failed checks, browser page errors, or pending media.
- Desktop at 1440 by 1000 and mobile at 390 by 844 had no page-level horizontal overflow in the landing page, documentation, source view, architecture document, or map.
- All six landing diagram controls opened valid source links. Search returned matching documents and an empty state. Escape closed search. Source filtering, line anchors, mobile navigation, map journey steps, component inspection, source dialogs, and the file index worked.
- Both Mermaid diagrams rendered without syntax errors.
- Eight axe scans covered the landing page, documentation library, architecture document, and map at both widths. No WCAG A or AA violations were reported.
- All 51 document routes returned a rendered page. The static crawl checked 648 HTML pages and 267,453 unique local file or fragment links. No broken links remained.
- Both video choices played at both widths, advanced their playback position, loaded captions, and linked to nonempty transcripts and downloads. The tour is 52.12 seconds at 1600 by 1000 with 13 caption cues. The runtime recording is 19.48 seconds at 1600 by 900 with five cues.

The detailed receipt is `verification.json`. Screenshots include `landing-desktop.png`, `landing-mobile.png`, `docs-desktop.png`, `docs-mobile.png`, `architecture-desktop.png`, `architecture-mobile.png`, `map-desktop.png`, `map-mobile.png`, and `map-mobile-canvas.png`.

These checks cover the static website in Chromium. They do not qualify native desktop behavior, external model providers, another browser engine, or physical touch devices. Automated accessibility scans have incomplete checks and do not establish full accessibility conformance. The runtime recording has its own evidence receipt under `public/media/runtime-recording-evidence.json`.

## Production verification

Netlify production deployment `6abe85f5bb01050ce526a797` reached `ready` and published at `2026-10-01T16:10:36.427Z`. The live origin is https://rig-os.netlify.app/.

The deployed-origin checker passed 59 checks. All 51 documentation routes loaded. All three MP4 downloads supported partial byte requests with HTTP 206 and the correct content type. Both embedded videos played and loaded captions. The hosted map journey, source dialog, documentation search, and both Mermaid diagrams worked. An unknown route returned 404. No browser page errors occurred. The full receipt is `hosted.json`; repeat with `node scripts/verify-hosted.mjs`.

The website dependency audit reported zero vulnerabilities. The original system-map publication checker also passed with 313 maintained files, 1,479 source references, and 602 Markdown links.
