// Table Lens — content script
//
// Detects tables, draws highlight overlays, and shows a compact draggable
// panel with the preview + controls. Click outside the panel disengages.

(() => {
  if (window.__tableLensLoaded) return;
  window.__tableLensLoaded = true;

  // ─── State ──────────────────────────────────────────────────────────────
  const state = {
    engaged: false,
    tables: [],          // [{ el, kind, headers, rows, score }]
    activeIndex: 0,
    selected: new Set(),
    host: null,
    shadow: null,
    panelEl: null,
    _overlayObserver: null,
    panelPos: null,      // { left, top } after first drag
    _justDragged: false, // suppress click-outside immediately after a drag
  };

  function activeSet() {
    if (state.selected.size) return [...state.selected].sort((a, b) => a - b);
    return state.tables.length ? [state.activeIndex] : [];
  }

  // The "visible" view of a table after user edits (deleted rows/cols).
  // Exports and the preview both flow through this.
  function tableView(t) {
    const headers = t.headers.filter((_, i) => !t.removedCols.has(i));
    const rows = [];
    for (let ri = 0; ri < t.rows.length; ri++) {
      if (t.removedRows.has(ri)) continue;
      rows.push(t.rows[ri].filter((_, ci) => !t.removedCols.has(ci)));
    }
    return { headers, rows };
  }

  function hasEdits(t) {
    return t.removedRows.size > 0 || t.removedCols.size > 0;
  }

  // ─── Detection ──────────────────────────────────────────────────────────

  function detectTables() {
    const found = [];
    const seen = new Set();

    function push(el, kind, headers, rows) {
      if (seen.has(el)) return;
      rows = rows.filter((r) => r.some((c) => c.text || c.href || c.src));
      if (rows.length < 2) return;

      const keepCol = headers.map((_, ci) =>
        rows.some((r) => {
          const c = r[ci];
          return c && (c.text || c.href || c.src);
        })
      );
      if (keepCol.some((k) => !k)) {
        headers = headers.filter((_, ci) => keepCol[ci]);
        rows = rows.map((r) => r.filter((_, ci) => keepCol[ci]));
      }
      if (headers.length < 2 || rows.length < 2) return;

      seen.add(el);
      found.push({
        el,
        kind,
        headers,
        rows,
        score: rows.length * Math.max(1, headers.length),
        removedRows: new Set(),
        removedCols: new Set(),
      });
    }

    document.querySelectorAll("table").forEach((t) => {
      if (!isVisible(t)) return;
      const data = extractFromNativeTable(t);
      push(t, "table", data.headers, data.rows);
    });

    document.querySelectorAll('[role="table"], [role="grid"]').forEach((t) => {
      if (t.tagName === "TABLE") return;
      if (!isVisible(t)) return;
      const data = extractFromAriaTable(t);
      push(t, "aria", data.headers, data.rows);
    });

    findRepeatingStructures().forEach((cand) => {
      const data = extractFromRepeating(cand.parent, cand.children);
      if (data.rows.length < 3) return;
      if (found.some((f) => f.el.contains(cand.parent) || cand.parent.contains(f.el))) return;
      push(cand.parent, "repeating", data.headers, data.rows);
    });

    found.sort((a, b) => b.score - a.score);
    return found;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function extractFromNativeTable(table) {
    const headerCells = table.querySelectorAll("thead th, thead td");
    let headers = [];
    if (headerCells.length) {
      headers = [...headerCells].map((c) => cleanText(c.textContent));
    } else {
      const firstRow = table.querySelector("tr");
      const ths = firstRow ? firstRow.querySelectorAll("th") : [];
      if (ths.length) headers = [...ths].map((c) => cleanText(c.textContent));
    }

    const bodySel = table.querySelector("tbody") ? "tbody tr" : "tr";
    const rowEls = [...table.querySelectorAll(bodySel)].filter((r) => {
      if (headers.length && r.querySelectorAll("th").length === r.children.length) return false;
      return true;
    });

    const rows = rowEls.map((tr) => [...tr.children].map((td) => cellPayload(td)));

    const maxCols = Math.max(0, ...rows.map((r) => r.length));
    if (!headers.length && maxCols) headers = Array.from({ length: maxCols }, (_, i) => `Column ${i + 1}`);
    while (headers.length < maxCols) headers.push(`Column ${headers.length + 1}`);
    rows.forEach((r) => {
      while (r.length < headers.length) r.push({ text: "", href: "", src: "" });
    });
    return { headers, rows };
  }

  function extractFromAriaTable(t) {
    const rowEls = [...t.querySelectorAll('[role="row"]')].filter(isVisible);
    let headers = [];
    const rows = [];

    rowEls.forEach((r) => {
      const cells = [...r.querySelectorAll(
        '[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]'
      )].filter((c) => c.closest('[role="row"]') === r);
      if (!cells.length) return;

      const payload = cells.map((c) => cellPayload(c));
      const isHeaderRow = cells.every((c) => c.getAttribute("role") === "columnheader");

      if (isHeaderRow && !headers.length) headers = payload.map((c) => c.text);
      else rows.push(payload);
    });

    const maxCols = Math.max(0, ...rows.map((r) => r.length), headers.length);
    if (!headers.length && maxCols) headers = Array.from({ length: maxCols }, (_, i) => `Column ${i + 1}`);
    while (headers.length < maxCols) headers.push(`Column ${headers.length + 1}`);
    rows.forEach((r) => {
      while (r.length < headers.length) r.push({ text: "", href: "", src: "" });
    });
    return { headers, rows };
  }

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "HEAD", "META", "LINK", "NOSCRIPT",
    "NAV", "HEADER", "FOOTER", "ASIDE", "FORM", "SELECT",
    "PICTURE", "VIDEO", "AUDIO", "SVG", "CANVAS",
  ]);

  function findRepeatingStructures() {
    const candidates = [];
    const elements = document.body.getElementsByTagName("*");
    for (const parent of elements) {
      if (SKIP_TAGS.has(parent.tagName)) continue;
      if (parent.children.length < 3) continue;
      if (parent.tagName === "TABLE" || parent.closest("table")) continue;
      if (parent.closest('[role="table"], [role="grid"]')) continue;
      if (!isVisible(parent)) continue;

      const buckets = new Map();
      for (const child of parent.children) {
        const sig = child.tagName;
        if (!buckets.has(sig)) buckets.set(sig, []);
        buckets.get(sig).push(child);
      }

      let best = null;
      for (const group of buckets.values()) {
        if (group.length >= 3 && (!best || group.length > best.length)) best = group;
      }
      if (!best) continue;

      const sample = best[Math.floor(best.length / 2)];
      const leafCount = collectLeaves(sample, sample).length;
      if (leafCount < 2) continue;
      candidates.push({ parent, children: best });
    }
    return candidates;
  }

  function extractFromRepeating(parent, items) {
    const itemLeaves = items.map((item) => collectLeaves(item, item));
    const pathCounts = new Map();
    for (const leaves of itemLeaves) {
      const seen = new Set();
      for (const { path } of leaves) {
        if (seen.has(path)) continue;
        seen.add(path);
        pathCounts.set(path, (pathCounts.get(path) || 0) + 1);
      }
    }
    const threshold = Math.ceil(items.length * 0.5);
    const paths = [...pathCounts.entries()].filter(([, n]) => n >= threshold).map(([p]) => p);
    if (!paths.length) return { headers: [], rows: [] };

    const headers = paths.map((_, i) => `Field ${i + 1}`);
    const rows = itemLeaves.map((leaves) => {
      const byPath = new Map(leaves.map((l) => [l.path, l]));
      return paths.map((p) => {
        const leaf = byPath.get(p);
        return leaf ? { text: leaf.text, href: leaf.href, src: leaf.src }
                    : { text: "", href: "", src: "" };
      });
    });
    return { headers, rows };
  }

  function collectLeaves(root, item, path = "") {
    const out = [];
    for (let i = 0; i < root.children.length; i++) {
      const child = root.children[i];
      const childPath = path + ">" + child.tagName + "[" + i + "]";
      if (child.children.length === 0) {
        const text = cleanText(child.textContent);
        const href = child.tagName === "A" ? child.href || "" : "";
        const src = child.tagName === "IMG" ? child.src || "" : "";
        if (text || href || src) out.push({ path: childPath, text, href, src });
      } else {
        out.push(...collectLeaves(child, item, childPath));
      }
    }
    if (!root.children.length) {
      const text = cleanText(root.textContent);
      if (text) out.push({ path, text, href: "", src: "" });
    }
    return out;
  }

  function cellPayload(td) {
    const link = td.querySelector("a[href]");
    const img = td.querySelector("img[src]");
    return {
      text: cleanText(td.textContent),
      href: link ? link.href : "",
      src: img ? img.src : "",
    };
  }

  function cleanText(s) { return (s || "").replace(/\s+/g, " ").trim(); }

  // ─── UI ─────────────────────────────────────────────────────────────────

  const UI_CSS = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
      color: #0F1419;
    }

    /* Highlight overlays */
    .overlays {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483644;
    }
    .highlight {
      position: fixed;
      top: 0;
      left: 0;
      pointer-events: none;
      border-radius: 4px;
      box-sizing: border-box;
      will-change: transform;
    }
    .highlight.active { border: 2px dashed #00A3A3; }
    .highlight.selected {
      border: 2px solid #00A3A3;
      background: rgba(0, 163, 163, 0.05);
    }
    .highlight.selected.active {
      border-style: solid;
      border-width: 2.5px;
      box-shadow: 0 0 0 1px rgba(0, 163, 163, 0.25);
    }
    .highlight-tag {
      position: absolute;
      top: -10px;
      left: 8px;
      transform: translateY(-100%);
      background: #00A3A3;
      color: #FFFFFF;
      font: 600 10.5px/1 -apple-system, "Inter", sans-serif;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 4px 6px;
      border-radius: 3px;
      white-space: nowrap;
    }

    /* Panel */
    .panel {
      position: fixed;
      /* Initial position is set in JS so the bottom-right resize grip
         grows the panel toward the bottom-right naturally. */
      width: 460px;
      height: 420px;
      min-width: 340px;
      min-height: 240px;
      max-width: 95vw;
      max-height: 95vh;
      z-index: 2147483646;
      background: #FAFAF7;
      border: 1px solid rgba(15, 20, 25, 0.14);
      border-radius: 8px;
      box-shadow: 0 12px 32px rgba(15, 20, 25, 0.16), 0 2px 4px rgba(15, 20, 25, 0.06);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      user-select: none;
      font-size: 13px;
    }

    /* Resize handles — one in every corner. Hit area 14x14; tiny L-shape
       indicator appears on panel hover so all four are discoverable. */
    .resize-handle {
      position: absolute;
      width: 14px;
      height: 14px;
      z-index: 5;
    }
    .resize-handle::before {
      content: "";
      position: absolute;
      width: 6px;
      height: 6px;
      border-color: rgba(15, 20, 25, 0.28);
      border-style: solid;
      border-width: 0;
      opacity: 0;
      transition: opacity 120ms ease, border-color 120ms ease;
    }
    .panel:hover .resize-handle::before { opacity: 1; }
    .resize-handle:hover::before { border-color: #00A3A3; border-width: 2px; }

    .resize-handle.nw { top: 0;    left: 0;    cursor: nw-resize; border-top-left-radius: 8px; }
    .resize-handle.ne { top: 0;    right: 0;   cursor: ne-resize; border-top-right-radius: 8px; }
    .resize-handle.sw { bottom: 0; left: 0;    cursor: sw-resize; border-bottom-left-radius: 8px; }
    .resize-handle.se { bottom: 0; right: 0;   cursor: se-resize; border-bottom-right-radius: 8px; }

    .resize-handle.nw::before { top: 4px;    left: 4px;    border-top-width: 2px;    border-left-width: 2px; }
    .resize-handle.ne::before { top: 4px;    right: 4px;   border-top-width: 2px;    border-right-width: 2px; }
    .resize-handle.sw::before { bottom: 4px; left: 4px;    border-bottom-width: 2px; border-left-width: 2px; }
    .resize-handle.se::before { bottom: 4px; right: 4px;   border-bottom-width: 2px; border-right-width: 2px; }

    .panel-head {
      display: flex;
      align-items: center;
      height: 36px;
      padding: 0 4px 0 10px;
      background: #FAFAF7;
      border-bottom: 1px solid rgba(15, 20, 25, 0.08);
      cursor: grab;
      flex-shrink: 0;
    }
    .panel-head.dragging { cursor: grabbing; }

    .grip {
      display: inline-block;
      width: 10px;
      height: 14px;
      margin-right: 8px;
      background-image:
        radial-gradient(circle, #B8BFC9 1px, transparent 1px);
      background-size: 4px 4px;
      background-position: 0 0;
      opacity: 0.6;
    }

    .panel button {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 8px;
      height: 26px;
      border-radius: 4px;
      color: #0F1419;
      font: 500 13px/1 inherit;
      cursor: pointer;
      transition: background-color 120ms ease;
      white-space: nowrap;
    }
    .panel button:hover { background: rgba(15, 20, 25, 0.05); }
    .panel button:focus-visible { box-shadow: 0 0 0 2px #00A3A3; outline: none; }
    .panel button[disabled] { opacity: 0.32; pointer-events: none; }
    .panel button.icon { padding: 0 6px; }
    .panel button.icon-sm { padding: 0 5px; height: 24px; font-size: 12px; }

    .pager {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .pager-count {
      font-variant-numeric: tabular-nums;
      font-feature-settings: "tnum";
      min-width: 86px;
      text-align: center;
      font-size: 12.5px;
      padding: 0 2px;
    }
    .pager-count em { font-style: normal; color: #8891A0; margin: 0 2px; }
    .pager-count .empty-count {
      font-size: 11.5px;
      font-weight: 500;
      color: #8891A0;
      letter-spacing: 0.01em;
    }

    .close-btn { color: #8891A0; margin-left: auto; }

    /* Actions row */
    .panel-actions {
      display: flex;
      align-items: center;
      height: 36px;
      padding: 0 8px;
      gap: 4px;
      background: #FAFAF7;
      border-bottom: 1px solid rgba(15, 20, 25, 0.08);
      flex-shrink: 0;
    }
    .panel-actions .divider {
      width: 1px;
      align-self: center;
      height: 18px;
      background: rgba(15, 20, 25, 0.08);
      margin: 0 4px;
    }
    .copy-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8891A0;
      padding-right: 2px;
    }
    .selection-count {
      font-size: 10.5px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: #00A3A3;
      background: rgba(0, 163, 163, 0.10);
      padding: 3px 6px;
      border-radius: 3px;
      letter-spacing: 0.02em;
      margin-left: 2px;
    }
    .panel button.is-on {
      background: rgba(0, 163, 163, 0.12);
      color: #00A3A3;
    }
    .copy-btn { font-size: 12px; padding: 0 7px; }

    /* Meta strip */
    .panel-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: #FFFFFF;
      border-bottom: 1px solid rgba(15, 20, 25, 0.06);
      flex-shrink: 0;
    }
    .kind-tag {
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(0, 163, 163, 0.10);
      color: #00A3A3;
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .meta-text {
      font-size: 11px;
      color: #545C66;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.01em;
    }
    .link-btn {
      all: unset;
      margin-left: auto;
      font-size: 10.5px;
      font-weight: 500;
      color: #00A3A3;
      cursor: pointer;
      letter-spacing: 0.02em;
    }
    .link-btn:hover { color: #008787; }

    /* Preview */
    .panel-body {
      flex: 1;
      overflow: auto;
      background: #FFFFFF;
      user-select: text;
    }
    .state-msg {
      padding: 36px 16px;
      text-align: center;
      color: #8891A0;
      font-size: 12px;
    }
    .state-msg strong { color: #545C66; display: block; margin-bottom: 4px; font-size: 13px; }

    table.data {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      color: #0F1419;
    }
    table.data th, table.data td {
      text-align: left;
      padding: 6px 10px;
      border-bottom: 1px solid rgba(15, 20, 25, 0.05);
      vertical-align: top;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    table.data thead th {
      position: sticky;
      top: 0;
      background: #FAFAF7;
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #545C66;
      border-bottom: 1px solid rgba(15, 20, 25, 0.14);
      z-index: 1;
    }

    /* Action cells — leading column with row-delete button */
    table.data th.action-cell,
    table.data td.action-cell {
      width: 24px;
      max-width: 24px;
      padding: 0 4px;
      text-align: center;
      background: #FAFAF7;
    }
    table.data tbody tr { position: relative; }
    .row-delete, .col-delete {
      all: unset;
      box-sizing: border-box;
      width: 14px;
      height: 14px;
      font: 600 9px/1 -apple-system, "Inter", sans-serif;
      color: #8891A0;
      background: rgba(15, 20, 25, 0.06);
      border-radius: 2px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 100ms ease, background 100ms ease, color 100ms ease;
      user-select: none;
    }
    .row-delete:hover, .col-delete:hover {
      background: #9B2C2C;
      color: #FFFFFF;
    }
    table.data tbody tr:hover .row-delete { opacity: 1; }
    table.data thead th { padding-right: 18px; }
    .col-delete {
      position: absolute;
      top: 4px;
      right: 4px;
    }
    table.data thead th:hover .col-delete { opacity: 1; }
    table.data thead th.action-cell { padding-right: 4px; }
    table.data thead th.action-cell .col-delete { display: none; }
    table.data tbody tr:hover { background: #FAFAF7; }
    table.data td.num {
      font-variant-numeric: tabular-nums;
      font-feature-settings: "tnum";
    }
    table.data a { color: #00A3A3; text-decoration: none; }
    table.data a:hover { text-decoration: underline; }

    .section-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding: 10px 12px 4px;
      background: #FAFAF7;
      border-top: 1px solid rgba(15, 20, 25, 0.08);
    }
    .section-head:first-child { border-top: none; }
    .section-num {
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #00A3A3;
    }
    .section-meta {
      font-size: 9.5px;
      color: #8891A0;
      font-variant-numeric: tabular-nums;
    }

    .preview-footnote {
      padding: 6px 12px;
      font-size: 10px;
      color: #8891A0;
      background: #F4F3EE;
      border-top: 1px solid rgba(15, 20, 25, 0.06);
      letter-spacing: 0.01em;
    }

    /* Toast */
    .toast {
      position: absolute;
      bottom: 10px;
      left: 50%;
      transform: translate(-50%, 8px);
      padding: 6px 10px;
      background: #0F1419;
      color: #FAFAF7;
      border-radius: 4px;
      font-size: 11.5px;
      font-weight: 500;
      letter-spacing: 0.01em;
      opacity: 0;
      pointer-events: none;
      transition: opacity 160ms ease, transform 160ms ease;
      z-index: 10;
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
    .toast.error { background: #9B2C2C; }
  `;

  function buildUI() {
    if (state.host) return;
    const host = document.createElement("div");
    host.id = "table-lens-host";
    host.style.all = "initial";
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = UI_CSS;
    shadow.appendChild(style);

    const overlays = document.createElement("div");
    overlays.className = "overlays";
    overlays.dataset.role = "overlays";
    shadow.appendChild(overlays);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="panel-head" data-role="head">
        <span class="grip" aria-hidden="true"></span>
        <div class="pager">
          <button class="icon" data-action="prev" title="Previous (Alt + ←)">◂</button>
          <div class="pager-count" data-role="count">— <em>/</em> —</div>
          <button class="icon" data-action="next" title="Next (Alt + →)">▸</button>
        </div>
        <button class="icon close-btn" data-action="close" title="Disengage">✕</button>
      </div>

      <div class="panel-actions">
        <button class="icon-sm" data-action="toggle-select" data-role="toggle-select" title="Add to selection (Space)">＋</button>
        <button class="icon-sm" data-action="select-all" title="Select all">All</button>
        <button class="icon-sm" data-action="clear" data-role="clear" title="Clear selection" hidden>Clear</button>
        <span class="selection-count" data-role="selection-count" hidden></span>
        <div class="divider"></div>
        <span class="copy-label" data-role="copy-label">Copy</span>
        <button class="copy-btn" data-action="copy-html" title="Copy as HTML — paste into Sheets, Docs, Notion">Table</button>
        <button class="copy-btn" data-action="copy-csv" title="Copy as CSV">CSV</button>
        <button class="copy-btn" data-action="copy-png" title="Copy as PNG image">PNG</button>
      </div>

      <div class="panel-meta" data-role="meta-row" hidden>
        <span class="kind-tag" data-role="kind-tag"></span>
        <span class="meta-text" data-role="meta-text"></span>
        <button class="link-btn" data-action="rescan" title="Re-detect tables">Rescan</button>
      </div>

      <div class="panel-body" data-role="body">
        <div class="state-msg"><strong>Detecting tables…</strong></div>
      </div>

      <div class="toast" data-role="toast"></div>
      <div class="resize-handle nw" data-role="resize" data-dir="nw" title="Drag corner to resize"></div>
      <div class="resize-handle ne" data-role="resize" data-dir="ne" title="Drag corner to resize"></div>
      <div class="resize-handle sw" data-role="resize" data-dir="sw" title="Drag corner to resize"></div>
      <div class="resize-handle se" data-role="resize" data-dir="se" title="Drag corner to resize"></div>
    `;
    shadow.appendChild(panel);

    panel.addEventListener("click", onPanelClick);
    setupDrag(panel.querySelector('[data-role="head"]'), panel);
    panel.querySelectorAll('[data-role="resize"]').forEach((h) =>
      setupResize(h, panel, h.dataset.dir)
    );

    document.documentElement.appendChild(host);
    state.host = host;
    state.shadow = shadow;
    state.panelEl = panel;

    // Default to top-right (just under the toolbar icon). Drag overrides.
    positionPanelTopRight();
    if (state.panelPos) applyPanelPos();
  }

  function positionPanelTopRight() {
    if (!state.panelEl) return;
    const w = state.panelEl.offsetWidth || 460;
    const TOP = 12;
    const RIGHT_MARGIN = 12;
    const left = Math.max(12, window.innerWidth - w - RIGHT_MARGIN);
    state.panelEl.style.left = `${left}px`;
    state.panelEl.style.top = `${TOP}px`;
    state.panelEl.style.right = "auto";
    state.panelEl.style.bottom = "auto";
  }

  function teardownUI() {
    if (state.host?.parentNode) state.host.parentNode.removeChild(state.host);
    state.host = null;
    state.shadow = null;
    state.panelEl = null;
  }

  function applyPanelPos() {
    if (!state.panelEl || !state.panelPos) return;
    state.panelEl.style.left = `${state.panelPos.left}px`;
    state.panelEl.style.top = `${state.panelPos.top}px`;
    state.panelEl.style.right = "auto";
    state.panelEl.style.bottom = "auto";
  }

  function setupResize(handle, target, dir) {
    const MIN_W = 340, MIN_H = 240;
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = target.getBoundingClientRect();
      const baseW = rect.width;
      const baseH = rect.height;
      const baseLeft = rect.left;
      const baseTop = rect.top;

      const onMove = (mv) => {
        const dx = mv.clientX - startX;
        const dy = mv.clientY - startY;

        let w = baseW, h = baseH, left = baseLeft, top = baseTop;

        // East: drag widens to the right. West: drag widens to the left (so
        // left edge shifts with the cursor while the right edge stays put).
        if (dir.includes("e")) {
          w = baseW + dx;
        } else if (dir.includes("w")) {
          w = baseW - dx;
          left = baseLeft + dx;
        }

        if (dir.includes("s")) {
          h = baseH + dy;
        } else if (dir.includes("n")) {
          h = baseH - dy;
          top = baseTop + dy;
        }

        // Enforce min size without ripping the anchored edge off the page
        if (w < MIN_W) {
          if (dir.includes("w")) left = baseLeft + (baseW - MIN_W);
          w = MIN_W;
        }
        if (h < MIN_H) {
          if (dir.includes("n")) top = baseTop + (baseH - MIN_H);
          h = MIN_H;
        }

        // Keep panel on screen
        const maxW = Math.max(MIN_W, window.innerWidth - 8);
        const maxH = Math.max(MIN_H, window.innerHeight - 8);
        if (w > maxW) {
          if (dir.includes("w")) left = baseLeft + (baseW - maxW);
          w = maxW;
        }
        if (h > maxH) {
          if (dir.includes("n")) top = baseTop + (baseH - maxH);
          h = maxH;
        }
        left = Math.max(0, Math.min(window.innerWidth - w, left));
        top = Math.max(0, Math.min(window.innerHeight - h, top));

        target.style.width = `${w}px`;
        target.style.height = `${h}px`;
        target.style.left = `${left}px`;
        target.style.top = `${top}px`;
        target.style.right = "auto";
        target.style.bottom = "auto";

        state.panelPos = { left, top };
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        state._justDragged = true;
        setTimeout(() => { state._justDragged = false; }, 80);
      };

      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    });
  }

  function setupDrag(handle, target) {
    handle.addEventListener("mousedown", (e) => {
      // Don't drag when clicking on a button inside the header
      if (e.target.closest("button")) return;
      e.preventDefault();

      const startX = e.clientX;
      const startY = e.clientY;
      const rect = target.getBoundingClientRect();
      const baseLeft = rect.left;
      const baseTop = rect.top;
      let dragging = false;

      const onMove = (mv) => {
        const dx = mv.clientX - startX;
        const dy = mv.clientY - startY;
        if (!dragging) {
          if (Math.abs(dx) + Math.abs(dy) < 4) return;
          dragging = true;
          handle.classList.add("dragging");
        }
        const left = Math.max(0, Math.min(window.innerWidth - rect.width, baseLeft + dx));
        const top = Math.max(0, Math.min(window.innerHeight - rect.height, baseTop + dy));
        target.style.left = `${left}px`;
        target.style.top = `${top}px`;
        target.style.right = "auto";
        target.style.bottom = "auto";
        state.panelPos = { left, top };
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        handle.classList.remove("dragging");
        if (dragging) {
          // Block the immediately-following document mousedown handler
          state._justDragged = true;
          setTimeout(() => { state._justDragged = false; }, 80);
        }
      };

      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    });
  }

  // ─── Click-outside-to-disengage ────────────────────────────────────────

  function onDocMouseDown(e) {
    if (!state.engaged || !state.host) return;
    if (state._justDragged) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(state.host)) return; // clicks inside the panel are fine
    disengage();
  }

  // ─── Panel actions ─────────────────────────────────────────────────────

  function onPanelClick(ev) {
    const btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    switch (action) {
      case "prev":          cycle(-1); break;
      case "next":          cycle(1); break;
      case "toggle-select": toggleSelectActive(); break;
      case "select-all":    selectAll(); break;
      case "clear":         clearSelection(); break;
      case "rescan":        rescan(); break;
      case "copy-html":     copyAs("html", btn); break;
      case "copy-csv":      copyAs("csv", btn); break;
      case "copy-png":      copyAs("png", btn); break;
      case "close":         disengage(); break;
      case "delete-row":    deleteRow(+btn.dataset.tableIdx, +btn.dataset.rowIdx); break;
      case "delete-col":    deleteCol(+btn.dataset.tableIdx, +btn.dataset.colIdx); break;
      case "reset-edits":   resetEdits(+btn.dataset.tableIdx); break;
    }
  }

  function deleteRow(tableIdx, rowIdx) {
    const t = state.tables[tableIdx];
    if (!t || !Number.isInteger(rowIdx) || rowIdx < 0 || rowIdx >= t.rows.length) return;
    t.removedRows.add(rowIdx);
    renderPreview();
  }

  function deleteCol(tableIdx, colIdx) {
    const t = state.tables[tableIdx];
    if (!t || !Number.isInteger(colIdx) || colIdx < 0 || colIdx >= t.headers.length) return;
    t.removedCols.add(colIdx);
    renderPreview();
  }

  function resetEdits(tableIdx) {
    const t = state.tables[tableIdx];
    if (!t) return;
    t.removedRows.clear();
    t.removedCols.clear();
    renderPreview();
  }

  function cycle(delta) {
    if (!state.tables.length) return;
    state.activeIndex = (state.activeIndex + delta + state.tables.length) % state.tables.length;
    render();
  }

  function toggleSelectActive() {
    if (!state.tables.length) return;
    if (state.selected.has(state.activeIndex)) state.selected.delete(state.activeIndex);
    else state.selected.add(state.activeIndex);
    render();
  }

  function selectAll() {
    if (!state.tables.length) return;
    if (state.selected.size === state.tables.length) state.selected.clear();
    else state.selected = new Set(state.tables.map((_, i) => i));
    render();
  }

  function clearSelection() {
    state.selected.clear();
    render();
  }

  function rescan() {
    if (!state.engaged) return;
    state.tables = detectTables();
    state.activeIndex = Math.min(state.activeIndex, Math.max(0, state.tables.length - 1));
    state.selected = new Set([...state.selected].filter((i) => i < state.tables.length));
    render();
  }

  // ─── Render ────────────────────────────────────────────────────────────

  function render() {
    if (!state.shadow) return;

    const total = state.tables.length;
    const idx = state.activeIndex;
    const selSize = state.selected.size;

    const count = state.shadow.querySelector('[data-role="count"]');
    if (total === 0) count.innerHTML = `<span class="empty-count">No tables found</span>`;
    else count.innerHTML = `${idx + 1} <em>/</em> ${total}`;

    state.shadow.querySelector('[data-action="prev"]').disabled = total < 2;
    state.shadow.querySelector('[data-action="next"]').disabled = total < 2;

    const toggle = state.shadow.querySelector('[data-role="toggle-select"]');
    const all = state.shadow.querySelector('[data-action="select-all"]');
    const clearBtn = state.shadow.querySelector('[data-role="clear"]');
    const selCount = state.shadow.querySelector('[data-role="selection-count"]');

    toggle.disabled = total === 0;
    all.disabled = total === 0;
    const activeInSel = state.selected.has(idx);
    toggle.textContent = activeInSel ? "−" : "+";
    toggle.title = activeInSel ? "Remove from selection (Space)" : "Add to selection (Space)";
    toggle.classList.toggle("is-on", activeInSel);
    all.textContent = selSize === total && total > 0 ? "None" : "All";
    clearBtn.hidden = selSize === 0;
    selCount.hidden = selSize === 0;
    if (selSize > 0) selCount.textContent = `${selSize} selected`;

    const copyLabel = state.shadow.querySelector('[data-role="copy-label"]');
    copyLabel.textContent = selSize > 1 ? `Copy ${selSize}` : "Copy";
    state.shadow.querySelectorAll(".copy-btn").forEach((b) => (b.disabled = total === 0));

    const metaRow = state.shadow.querySelector('[data-role="meta-row"]');
    if (total === 0) {
      metaRow.hidden = true;
    } else {
      metaRow.hidden = false;
      const t = state.tables[idx];
      state.shadow.querySelector('[data-role="kind-tag"]').textContent =
        t.kind === "table" ? "Native" : t.kind === "aria" ? "Aria" : "Inferred";

      const visRows = t.rows.length - t.removedRows.size;
      const visCols = t.headers.length - t.removedCols.size;
      const edited = hasEdits(t);
      const metaTextEl = state.shadow.querySelector('[data-role="meta-text"]');
      metaTextEl.innerHTML = edited
        ? `<span style="color: #00A3A3;">${visRows.toLocaleString()} of ${t.rows.length.toLocaleString()} rows · ${visCols} of ${t.headers.length} cols</span>
           <button class="link-btn" data-action="reset-edits" data-table-idx="${idx}" style="margin: 0 0 0 6px; color: #9B2C2C;">Reset</button>`
        : `${t.rows.length.toLocaleString()} rows · ${t.headers.length} cols`;
    }

    // Scroll active table into view
    document.querySelectorAll('[data-table-lens-active="true"]').forEach((el) =>
      el.removeAttribute("data-table-lens-active")
    );
    const active = state.tables[idx];
    if (active) {
      active.el.setAttribute("data-table-lens-active", "true");
      active.el.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    renderPreview();
    renderOverlays();
  }

  function renderPreview() {
    const body = state.shadow.querySelector('[data-role="body"]');
    body.innerHTML = "";

    if (!state.tables.length) {
      body.innerHTML = `<div class="state-msg">
        <strong>No tables on this page</strong>
        Try <button class="link-btn" data-action="rescan" style="margin: 0; padding: 0; color: #00A3A3;">Rescan</button> if the page is still loading.
      </div>`;
      return;
    }

    const indices = activeSet();
    const multi = indices.length > 1;

    indices.forEach((i) => {
      const t = state.tables[i];
      const view = tableView(t);
      const edited = hasEdits(t);
      const totalRows = t.rows.length - t.removedRows.size;

      if (multi || edited) {
        const section = document.createElement("div");
        section.className = "section-head";
        const metaText = edited
          ? `${view.rows.length.toLocaleString()} of ${t.rows.length.toLocaleString()} rows · ${view.headers.length} of ${t.headers.length} cols`
          : `${t.rows.length.toLocaleString()} rows · ${t.headers.length} cols`;
        section.innerHTML = `
          <span class="section-num">Table ${i + 1}</span>
          <span class="section-meta">
            ${metaText}
            ${edited ? `<button class="link-btn" data-action="reset-edits" data-table-idx="${i}" style="margin-left: 8px;">Reset</button>` : ""}
          </span>
        `;
        body.appendChild(section);
      }

      if (view.headers.length === 0 || view.rows.length === 0) {
        const msg = document.createElement("div");
        msg.className = "state-msg";
        msg.innerHTML = `<strong>Everything is hidden</strong>${
          edited ? `<button class="link-btn" data-action="reset-edits" data-table-idx="${i}">Reset</button>` : ""
        }`;
        body.appendChild(msg);
        return;
      }

      const dt = document.createElement("table");
      dt.className = "data";

      // Build a map of visible-col-index → original-col-index for header X buttons
      const visibleToOrigCol = [];
      t.headers.forEach((_, ci) => {
        if (!t.removedCols.has(ci)) visibleToOrigCol.push(ci);
      });

      const thead = document.createElement("thead");
      const trh = document.createElement("tr");
      const actionTh = document.createElement("th");
      actionTh.className = "action-cell";
      trh.appendChild(actionTh);
      view.headers.forEach((h, visCi) => {
        const th = document.createElement("th");
        th.textContent = h || "—";
        const x = document.createElement("button");
        x.className = "col-delete";
        x.textContent = "✕";
        x.dataset.action = "delete-col";
        x.dataset.tableIdx = String(i);
        x.dataset.colIdx = String(visibleToOrigCol[visCi]);
        x.title = "Hide this column";
        th.appendChild(x);
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      dt.appendChild(thead);

      const tbody = document.createElement("tbody");
      const SHOWN = 500;

      // We want to skip removed rows but still report visible row #s with
      // original indices for the delete button.
      let visibleCount = 0;
      for (let ri = 0; ri < t.rows.length && visibleCount < SHOWN; ri++) {
        if (t.removedRows.has(ri)) continue;
        visibleCount++;

        const tr = document.createElement("tr");
        const actionTd = document.createElement("td");
        actionTd.className = "action-cell";
        const xRow = document.createElement("button");
        xRow.className = "row-delete";
        xRow.textContent = "✕";
        xRow.dataset.action = "delete-row";
        xRow.dataset.tableIdx = String(i);
        xRow.dataset.rowIdx = String(ri);
        xRow.title = "Hide this row";
        actionTd.appendChild(xRow);
        tr.appendChild(actionTd);

        // Visible row cells
        const row = t.rows[ri];
        row.forEach((cell, ci) => {
          if (t.removedCols.has(ci)) return;
          const td = document.createElement("td");
          if (isNumeric(cell.text)) td.className = "num";
          if (cell.href) {
            const a = document.createElement("a");
            a.href = cell.href;
            a.target = "_blank";
            a.rel = "noopener";
            a.textContent = cell.text || cell.href;
            td.appendChild(a);
          } else {
            td.textContent = cell.text || (cell.src ? "[image]" : "");
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      dt.appendChild(tbody);
      body.appendChild(dt);

      if (totalRows > SHOWN) {
        const note = document.createElement("div");
        note.className = "preview-footnote";
        note.textContent = `Preview of ${SHOWN} of ${totalRows.toLocaleString()} rows. Full set is copied.`;
        body.appendChild(note);
      }
    });
  }

  function isNumeric(s) {
    if (!s) return false;
    return /^-?[\d,.$%\s]+$/.test(s) && /\d/.test(s);
  }

  // ─── Overlays ──────────────────────────────────────────────────────────

  // Build the list of overlays the current state wants. Non-active selected
  // tables come first so the active one paints on top.
  function overlayPlan() {
    const plan = [];
    state.selected.forEach((i) => {
      if (i === state.activeIndex) return;
      plan.push({ i, active: false, selected: true, label: `Table ${i + 1}` });
    });
    if (state.tables[state.activeIndex]) {
      plan.push({
        i: state.activeIndex,
        active: true,
        selected: state.selected.has(state.activeIndex),
        label: `Table ${state.activeIndex + 1}`,
      });
    }
    return plan;
  }

  // Reconcile DOM nodes to match the plan. Called on state changes.
  function renderOverlays() {
    if (!state.shadow) return;
    const overlays = state.shadow.querySelector('[data-role="overlays"]');
    const plan = overlayPlan();

    while (overlays.children.length > plan.length) overlays.removeChild(overlays.lastChild);
    while (overlays.children.length < plan.length) {
      const div = document.createElement("div");
      div.className = "highlight";
      const tag = document.createElement("div");
      tag.className = "highlight-tag";
      div.appendChild(tag);
      overlays.appendChild(div);
    }

    plan.forEach((entry, idx) => {
      const div = overlays.children[idx];
      div.className =
        "highlight" + (entry.active ? " active" : "") + (entry.selected ? " selected" : "");
      const tag = div.firstChild;
      tag.textContent = entry.label || "";
    });

    positionOverlays();
  }

  // Position-only update — fast path used during scroll/resize. No DOM
  // creation, just transform writes, so scrolling stays glued to the page.
  function positionOverlays() {
    if (!state.shadow) return;
    const overlays = state.shadow.querySelector('[data-role="overlays"]');
    const plan = overlayPlan();
    if (overlays.children.length !== plan.length) return;

    plan.forEach((entry, idx) => {
      const div = overlays.children[idx];
      const t = state.tables[entry.i];
      if (!t) { div.style.display = "none"; return; }
      const rect = t.el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) { div.style.display = "none"; return; }
      div.style.display = "";
      div.style.transform = `translate3d(${(rect.left - 2).toFixed(2)}px, ${(rect.top - 2).toFixed(2)}px, 0)`;
      div.style.width = `${rect.width + 4}px`;
      div.style.height = `${rect.height + 4}px`;
    });
  }

  let _overlayRaf = null;
  function scheduleOverlayUpdate() {
    if (_overlayRaf) return;
    _overlayRaf = requestAnimationFrame(() => {
      _overlayRaf = null;
      positionOverlays();
    });
  }

  // ─── Engage / disengage ────────────────────────────────────────────────

  function engage() {
    if (state.engaged) return;
    state.engaged = true;
    state.selected.clear();
    state.activeIndex = 0;
    state.panelPos = null;

    buildUI();
    state.tables = detectTables();
    render();

    window.addEventListener("scroll", scheduleOverlayUpdate, { passive: true, capture: true });
    window.addEventListener("resize", scheduleOverlayUpdate, { passive: true });
    document.addEventListener("mousedown", onDocMouseDown, { capture: true });
    document.addEventListener("keydown", onDocKeyDown, { capture: true });
    state._overlayObserver = new MutationObserver(scheduleOverlayUpdate);
    state._overlayObserver.observe(document.body, {
      attributes: true, childList: true, subtree: true,
    });

    chrome.runtime.sendMessage({ type: "TABLE_LENS_BG_ENGAGED" }).catch(() => {});
  }

  function disengage() {
    if (!state.engaged) return;
    state.engaged = false;
    state.selected.clear();

    window.removeEventListener("scroll", scheduleOverlayUpdate, { capture: true });
    window.removeEventListener("resize", scheduleOverlayUpdate);
    document.removeEventListener("mousedown", onDocMouseDown, { capture: true });
    document.removeEventListener("keydown", onDocKeyDown, { capture: true });
    if (state._overlayObserver) {
      state._overlayObserver.disconnect();
      state._overlayObserver = null;
    }
    document.querySelectorAll('[data-table-lens-active="true"]').forEach((el) =>
      el.removeAttribute("data-table-lens-active")
    );
    teardownUI();

    chrome.runtime.sendMessage({ type: "TABLE_LENS_BG_DISENGAGED" }).catch(() => {});
  }

  function onDocKeyDown(ev) {
    if (!state.engaged) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      disengage();
    } else if (ev.altKey && ev.key === "ArrowRight") {
      ev.preventDefault();
      cycle(1);
    } else if (ev.altKey && ev.key === "ArrowLeft") {
      ev.preventDefault();
      cycle(-1);
    }
  }

  // ─── Export ────────────────────────────────────────────────────────────

  function toCSV(table) {
    const esc = (s) => {
      const v = (s ?? "").toString();
      return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const headerLine = table.headers.map(esc).join(",");
    const rowLines = table.rows.map((r) =>
      r.map((c) => esc(c.href ? `${c.text} (${c.href})` : c.text)).join(",")
    );
    return [headerLine, ...rowLines].join("\n");
  }

  function toCSVMulti(tables) {
    if (tables.length === 1) return toCSV(tables[0].table);
    return tables.map(({ table, label }) => `## ${label}\n${toCSV(table)}`).join("\n\n");
  }

  function toHTML(table, label) {
    const esc = (s) =>
      (s ?? "").toString()
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    let html = label ? `<h3>${esc(label)}</h3>` : "";
    html += "<table><thead><tr>";
    table.headers.forEach((h) => (html += `<th>${esc(h)}</th>`));
    html += "</tr></thead><tbody>";
    table.rows.forEach((row) => {
      html += "<tr>";
      row.forEach((cell) => {
        if (cell.href) html += `<td><a href="${esc(cell.href)}">${esc(cell.text || cell.href)}</a></td>`;
        else html += `<td>${esc(cell.text)}</td>`;
      });
      html += "</tr>";
    });
    html += "</tbody></table>";
    return html;
  }

  function toHTMLMulti(tables) {
    if (tables.length === 1) return toHTML(tables[0].table);
    return tables.map(({ table, label }) => toHTML(table, label)).join("\n");
  }

  async function toPNG(table) {
    const PAD = 20, CELL_PAD_X = 12, CELL_PAD_Y = 8;
    const FONT = '13px -apple-system, "Inter", "Segoe UI", sans-serif';
    const HEADER_FONT = '600 11px -apple-system, "Inter", "Segoe UI", sans-serif';
    const MAX_ROWS = Math.min(500, table.rows.length);
    const COL_MAX_W = 240;

    const m = document.createElement("canvas").getContext("2d");

    const headerLabels = table.headers.map((h) => (h || "").toUpperCase());
    const dataRows = table.rows.slice(0, MAX_ROWS).map((r) =>
      r.map((c) => c.text || (c.href ? c.href : c.src ? "[image]" : ""))
    );

    m.font = HEADER_FONT;
    const colWidths = headerLabels.map((h) => Math.min(COL_MAX_W, m.measureText(h).width + CELL_PAD_X * 2));
    m.font = FONT;
    dataRows.forEach((row) => {
      row.forEach((cell, i) => {
        const w = Math.min(COL_MAX_W, m.measureText(cell).width + CELL_PAD_X * 2);
        if (w > colWidths[i]) colWidths[i] = w;
      });
    });

    const rowH = 13 + CELL_PAD_Y * 2;
    const headerH = 11 + CELL_PAD_Y * 2 + 4;
    const tableW = colWidths.reduce((a, b) => a + b, 0);
    const tableH = headerH + rowH * dataRows.length;
    const truncated = table.rows.length > MAX_ROWS;
    const footerH = truncated ? 28 : 0;
    const W = tableW + PAD * 2;
    const H = tableH + PAD * 2 + footerH;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "rgba(15, 20, 25, 0.14)";
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD - 0.5, PAD - 0.5, tableW + 1, tableH + 1);

    ctx.fillStyle = "#FAFAF7";
    ctx.fillRect(PAD, PAD, tableW, headerH);
    ctx.font = HEADER_FONT;
    ctx.fillStyle = "#545C66";
    ctx.textBaseline = "middle";
    let x = PAD;
    headerLabels.forEach((h, i) => {
      drawText(ctx, h, x + CELL_PAD_X, PAD + headerH / 2, colWidths[i] - CELL_PAD_X * 2);
      x += colWidths[i];
    });

    ctx.strokeStyle = "rgba(15, 20, 25, 0.14)";
    ctx.beginPath();
    ctx.moveTo(PAD, PAD + headerH + 0.5);
    ctx.lineTo(PAD + tableW, PAD + headerH + 0.5);
    ctx.stroke();

    ctx.font = FONT;
    ctx.fillStyle = "#0F1419";
    dataRows.forEach((row, ri) => {
      const y = PAD + headerH + ri * rowH;
      let cx = PAD;
      row.forEach((cell, ci) => {
        drawText(ctx, cell, cx + CELL_PAD_X, y + rowH / 2, colWidths[ci] - CELL_PAD_X * 2);
        cx += colWidths[ci];
      });
      if (ri < dataRows.length - 1) {
        ctx.strokeStyle = "rgba(15, 20, 25, 0.06)";
        ctx.beginPath();
        ctx.moveTo(PAD, y + rowH + 0.5);
        ctx.lineTo(PAD + tableW, y + rowH + 0.5);
        ctx.stroke();
      }
    });

    if (truncated) {
      ctx.font = '11px -apple-system, "Inter", sans-serif';
      ctx.fillStyle = "#8891A0";
      ctx.textBaseline = "middle";
      ctx.fillText(`Showing first ${MAX_ROWS} of ${table.rows.length} rows`, PAD, H - PAD - footerH / 2 + 4);
    }

    return new Promise((res) => canvas.toBlob(res, "image/png"));
  }

  async function toPNGMulti(tables) {
    if (tables.length === 1) return toPNG(tables[0].table);
    const blobs = await Promise.all(tables.map(({ table }) => toPNG(table)));
    const bitmaps = await Promise.all(blobs.map((b) => createImageBitmap(b)));
    const PAD = 20, GAP = 28, LABEL_H = 24;
    const W = Math.max(...bitmaps.map((b) => b.width)) + PAD * 2;
    const sectionH = bitmaps.map((b) => b.height + LABEL_H + GAP);
    const H = PAD * 2 + sectionH.reduce((a, b) => a + b, 0) - GAP;

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, W, H);

    let y = PAD;
    bitmaps.forEach((bm, i) => {
      ctx.font = '600 13px -apple-system, "Inter", "Segoe UI", sans-serif';
      ctx.fillStyle = "#00A3A3";
      ctx.textBaseline = "middle";
      ctx.fillText(tables[i].label.toUpperCase(), PAD, y + LABEL_H / 2);
      ctx.strokeStyle = "rgba(0, 163, 163, 0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD, y + LABEL_H + 0.5);
      ctx.lineTo(W - PAD, y + LABEL_H + 0.5);
      ctx.stroke();
      ctx.drawImage(bm, PAD, y + LABEL_H);
      y += LABEL_H + bm.height + GAP;
    });

    return new Promise((res) => canvas.toBlob(res, "image/png"));
  }

  function drawText(ctx, text, x, y, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) {
      ctx.fillText(text, x, y);
      return;
    }
    const ellipsis = "…";
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    ctx.fillText(text.slice(0, lo) + ellipsis, x, y);
  }

  async function copyAs(format, btn) {
    const indices = activeSet();
    if (!indices.length) return;
    const tables = indices.map((i) => ({
      table: tableView(state.tables[i]),
      label: `Table ${i + 1}`,
    }));
    if (tables.every(({ table }) => table.rows.length === 0 || table.headers.length === 0)) {
      toast("Nothing left to copy", true);
      return;
    }
    try {
      if (format === "html") {
        const html = toHTMLMulti(tables);
        const plain = toCSVMulti(tables);
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plain], { type: "text/plain" }),
          }),
        ]);
      } else if (format === "csv") {
        await navigator.clipboard.writeText(toCSVMulti(tables));
      } else if (format === "png") {
        const blob = await toPNGMulti(tables);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      }
      toast(tables.length > 1 ? `Copied ${tables.length} tables` : "Copied");
    } catch (err) {
      console.error("Table Lens copy failed:", err);
      toast("Copy failed", true);
    }
  }

  let _toastTimer = null;
  function toast(msg, isError = false) {
    if (!state.shadow) return;
    const el = state.shadow.querySelector('[data-role="toast"]');
    el.textContent = msg;
    el.classList.toggle("error", isError);
    el.classList.add("show");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove("show"), 1300);
  }

  // ─── Message API (engage/disengage from background) ───────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "TABLE_LENS_ENGAGE") engage();
    else if (msg?.type === "TABLE_LENS_DISENGAGE") disengage();
    sendResponse({ ok: true });
  });
})();
