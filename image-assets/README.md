# ScummBench branding

The cursor detective reviews an evaluation clipboard, with a stopwatch for run
budgets. The pixel shapes, cream outlines, dark badge, amber coat, teal clipboard,
and lime accents relate to the AgentSCUMM and ScummWEB identities.

- `sources/` preserves the untouched native Codex ImageGen PNGs. The exact model
  and snapshot were not exposed; no model version is claimed.
- Root `logo.png` is the tightly padded README export. `logo/` and `icon/` contain
  square 1024 px variants; the icon has no text.
- `web-seo/` contains optional favicon, touch-icon, and social-preview exports.
  ScummBench is a CLI; these files do not imply a website or installable app.
- `manifest.json` records export dimensions. `provenance.json` records original
  source and final export SHA-256 fingerprints and derivation details.
- [Generation prompts](prompts.md) records the native ImageGen prompt set.

Logo and icon exports remove disconnected alpha specks while retaining the main
silhouette and its edge transparency. Original source files remain unchanged.
The README logo has 24 px of transparent padding. The wide preview uses its own
composition. Future edits should preserve the cream/dark contour and be checked
on light and dark backgrounds, with small icons checked at their actual sizes.

These records document generation and derivation; they do not establish artwork
licensing or certify the underlying image model.
