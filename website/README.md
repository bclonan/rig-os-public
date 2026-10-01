# Rig OS website

The public landing page, complete documentation, source browser, system map, and recorded walkthroughs live at [rig-os.netlify.app](https://rig-os.netlify.app/).

This is a static website. Visitors run the Rig OS service on their own computer. The website never connects to a local token or controls a desktop.

## Build and preview

Use Node 24.17 or newer in the 24.x line. From this directory:

```sh
npm ci
npm run build
npm run preview
```

Open `http://127.0.0.1:4337`. Set `PORT` to choose another port.

The build reads the repository's Git file list. It renders all 51 original Markdown files, creates source pages and raw downloads for text files, and copies the existing system map. Binary evidence and model weights link to the matching GitHub revision. It never copies runtime stores or the working directory wholesale. The output is `website/dist` and the generated inventory is `publication.json`.

Original Markdown, map data, and runtime implementation remain in their existing locations. The generated map adds website navigation. Its data, JavaScript, and stylesheet match the original bytes. Mermaid runs from a locally bundled dependency.

## Verify

Keep the preview server running, then run:

```sh
npm run verify
```

Browser checks cover the landing controls, docs search, source browsing, map journeys, code dialogs, responsive layout, and video playback. The script writes its measured results under `qa`.

From the repository root, verify the original source-to-map binding:

```sh
python docs/system-map/verify_publication.py
```

The runtime's historical quality receipts retain their original scope. Website checks do not replace a runtime qualification.

## Record the walkthroughs

The recording scripts require the Playwright Chromium browser and the `ffmpeg-static` executable. If npm reports that it blocked the package's install script, review and approve that package's installer before recording. The normal static build does not need ffmpeg.

With the website preview running, from this directory:

```sh
node scripts/record-tour.mjs
```

This records real interactions with the site and exports the standard website clip plus a social version with baked-in captions. It also writes captions, a transcript, posters, and a recording receipt in `public/media`.

For the local runtime recording, first install and build the runtime as described in its operating guide. From `computer-use-runtime`:

```sh
node --import tsx ../website/scripts/record-runtime.mjs
```

The script creates a disposable store and uses the real Vue console, Fastify service, SQLite, and Chromium fixture. It verifies task success and removes authentication from the published recording. It does not call an external model or operate the native desktop. Captions and the receipt state those limits.

Run the website build again after recording to publish the new media.

## Deploy

The repository root contains `netlify.toml`. The Netlify project is `rig-os`, with site ID `fdf8baf5-8926-45dd-ac6b-c1ab4afcc5fd`. Authenticate with your Netlify account, then deploy from the repository root:

```sh
npx netlify-cli deploy --prod --dir website/dist --no-build --site fdf8baf5-8926-45dd-ac6b-c1ab4afcc5fd
```

Build and verify before deploying. This delivery uses a CLI production deployment. It does not configure automatic deployments from GitHub.

The LinkedIn and X drafts are in `SOCIAL_POSTS.md`. They have not been posted to either platform.
