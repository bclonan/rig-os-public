# Public architecture map checks

The map indexes 300 maintained files and has 116 responsibility boxes, 180 relationships, 21 journeys, and 32 record explanations. The public maintained fingerprint is `4519517387a35a5706f3024966ebbf2615ba3d25b6194cc9b9cec9210138fdeb`.

## Static checks

Run these commands from the repository root:

```sh
python docs/system-map/refresh_publication.py
python docs/system-map/verify_publication.py
node --check docs/system-map/canvas.js
```

The checker verifies maintained source hashes, embedded file text, cited lines, graph endpoints, journey/view references, source index, canvas controls, and local Markdown links. [PUBLICATION_BINDING.json](PUBLICATION_BINDING.json) records exact bytes. Git revision is informational because a generated map cannot contain the ID of its own future commit.

The three publication-source changes require an independently reviewed [portable evidence record](../open-source/PORTABLE_EVIDENCE.md). They admit an exact training-origin derivative and add regressions. They do not qualify the models or permit the derivative to use historical successful-terminal compatibility.

## Browser interaction

The [Chromium report](../open-source/MAP_BROWSER.json) records a headless browser run of the actual static page. It checked pointer and keyboard pan, wheel and button zoom, Fit view, search and empty results, component details, source dialogs, Escape, all 21 journeys and 112 steps, 32 record explanations, the 300-file index, and the embedded operating guide.

The desktop viewport was 1365 by 900. The mobile viewport was 390 by 844 and had no horizontal page overflow. Chromium reported no page errors. Every request stayed on the loopback documentation server. The map bytes stayed unchanged during the check. Screenshots remain private outside the repository.

These checks did not start the assistant, open its store, read a token, call a model, or send native input. Touch hardware, screen-reader speech, and other browser engines remain untested. [Public runtime verification](../open-source/VERIFICATION.md) has its own evidence. Mac live execution, physical mixed-DPI, external integration, and general native learning remain open.
