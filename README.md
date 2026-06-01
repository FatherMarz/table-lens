# Table Lens

A Chrome extension that finds tabular data on any page, lets you cycle through detected tables, multi-select, preview, and copy as **HTML**, **CSV**, or **PNG**.

A compact draggable panel sits inside the page. The active and selected tables get clean teal highlight rectangles. Click anywhere outside the panel to disengage.

## Install (unpacked)

Table Lens isn't on the Chrome Web Store. Load it unpacked:

1. Download the repo (`git clone https://github.com/FatherMarz/table-lens.git`, or grab the ZIP and unzip it).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the `table-lens` folder (the one containing `manifest.json`).
6. Pin the **Table Lens** icon to your toolbar.

Works in any Chromium browser (Chrome, Edge, Brave, Arc). To update later, `git pull` then hit **Reload** on the card in `chrome://extensions`.

## How to use

- **Click the toolbar icon** to engage on the current tab. A 460×380 panel appears bottom-right with the data preview and controls; teal rectangles highlight every detected table on the page.
- **Drag the panel** by its header (the strip with the row of dots). Position is remembered for the engagement.
- **Click anywhere outside the panel** to disengage — page interaction comes back, overlays vanish.
- Inside the panel:
  - **◂ N / M ▸** — cycle through detected tables. The active table gets a dashed outline; selected tables get a solid outline.
  - **＋ / All / Clear** — multi-selection. `＋` toggles the current table in/out of the selection. `All` selects every detected table (`None` if all are already selected). `Clear` deselects everything.
  - **Hide rows / columns** — hover a row → red `✕` appears at its left to hide that row. Hover a column header → `✕` at the header's top-right hides that column. Hidden rows/columns are excluded from **everything you copy** (HTML, CSV, PNG). The meta strip shows `12 of 18 rows · 4 of 7 cols` when edits are active, with a **Reset** link to restore. Edits are per-table.
  - **Copy: Table / CSV / PNG** — copies the selection if there is one, otherwise the active table.
    - **Table** — HTML; pastes into Sheets, Excel, Docs, or Notion with formatting preserved. Multi-select inserts `<h3>Table N</h3>` between blocks.
    - **CSV** — plain text. Multi-select separates blocks with `## Table N` heading lines.
    - **PNG** — image rendered in Table Lens's own clean style. Multi-select stacks tables vertically with teal labels.
  - **Rescan** (in the meta strip) — re-detect tables, e.g. after the page finishes loading.
  - **✕** (top-right) — disengage.
- **Keyboard while engaged:**
  - `Esc` — disengage.
  - `Alt + ←` / `Alt + →` — cycle tables.
- Selecting text inside the preview works normally (drag-select); only mousedowns *outside* the panel disengage.

## What it detects

- All visible `<table>` elements with at least two rows.
- `role="table"` and `role="grid"` ARIA tables (most modern React/data-grid components).
- Repeating-row structures (lists of cards, search results, product grids) — looks for any element with 3+ children sharing the same tag, where each child has multiple text-bearing descendants. Biggest, richest tables rank first.

## Per-tab and ephemeral

Per-tab state. Navigating away or closing the tab clears the lens. No background scraping, no storage, no network.

## Files

- `manifest.json` — Manifest V3, permissions: `activeTab`, `scripting`, `storage`.
- `background.js` — service worker; toolbar click toggles engagement, manages the `ON` badge.
- `content.js` — detection, Shadow-DOM panel + overlays, drag, copy.
- `content.css` — single rule for active-table `scroll-margin`.
- `icons/` — 16/32/48/128 PNGs.

## License

MIT — see [LICENSE](LICENSE).
