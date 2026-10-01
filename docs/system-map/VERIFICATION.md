# Public architecture map checks

The map indexes 313 maintained files and has 120 responsibility boxes, 189 relationships, 22 journeys, and 33 record explanations. The public maintained fingerprint is `f99ce9d585d2a6dd846bec58865232ba7f7ec22ded7189e450112b9e0c967333`.

## Static checks

Run these commands from the repository root:

```sh
python docs/system-map/refresh_publication.py
python docs/system-map/verify_publication.py
node --check docs/system-map/canvas.js
```

The checker verifies maintained source hashes, embedded file text, cited lines, graph endpoints, journey/view references, source index, canvas controls, and local Markdown links. [PUBLICATION_BINDING.json](PUBLICATION_BINDING.json) records exact bytes. Git revision is informational because a generated map cannot contain the ID of its own future commit.

The three original publication-source changes retain their frozen [portable evidence record](../open-source/PORTABLE_EVIDENCE.md). They admit an exact training-origin derivative and add regressions. The later [provider maintenance trace](SOURCE_UPDATES/provider-selection-v1.json) records 34 changed or added files and seven explicitly replaced anchors. Its checked source chain preserves the portable-origin base. Neither record qualifies the models or permits the derivative to use historical successful-terminal compatibility.

## Browser interaction

The [Chromium report](../open-source/MAP_BROWSER.json) records a headless browser run of the actual static page. It checks pointer and keyboard pan, wheel and button zoom, Fit view, search and empty results, component details, source dialogs, Escape, all 22 journeys and 118 steps, 33 record explanations, the 313-file index, and the embedded operating guide. The provider view explains consent, CLI boundaries, ensemble selection, and the separation from action approval.

The desktop viewport was 1365 by 900. The mobile viewport was 390 by 844 and had no horizontal page overflow. Chromium reported no page errors. Every request stayed on the loopback documentation server. The map bytes stayed unchanged during the check. Screenshots remain private outside the repository.

These checks did not start the assistant, open its store, read a token, call a model, or send native input. Touch hardware, screen-reader speech, and other browser engines remain untested. [Public runtime verification](../open-source/VERIFICATION.md) has its own evidence. Mac live execution, physical mixed-DPI, external integration, and general native learning remain open.
