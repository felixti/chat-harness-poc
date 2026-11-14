# Deck themes

One JSON file per theme; the file name is the theme name the model uses in the deck spec
(`"theme": "ivory"`). `generate_pptx` reads this folder on every call, so adding or editing a
file here changes the available themes without touching code.

Required: `bg`, `surface`, `ink`, `muted`, `accent`, `accent2`, `onAccent`, `line` (hex),
`chart` (3+ hex), `headFont`, `bodyFont`. Optional: `style` (`classic`, `editorial`, `modern`:
composition, not only color), `darkCover`, `good`, `bad`, and the descriptive `look` /
`good_for` (keep the table in `reference.md` in sync).

Invalid files are skipped with a log line. Contrast is checked at render time
(`ink` on `bg` 4.5:1, `muted` 3:1, `onAccent` on `accent` 4.5:1). Fonts must exist on the
viewer's machine (Aptos ships with Office 365; Georgia everywhere).
