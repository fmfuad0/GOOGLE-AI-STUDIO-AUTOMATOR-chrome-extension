/**
 * @fileoverview Output Viewer — reads IndexedDB output buffer and
 * renders it in five modes: Text, Markdown, Code Block, Table, JSON.
 *
 * Download behaviour (per spec):
 *   Text      → single .txt file
 *   Markdown  → ZIP, one .md per entry
 *   Code      → ZIP, one file per entry (ext = detected language)
 *   Table     → format modal → ZIP, one .csv or .xlsx per entry
 *   JSON      → ZIP, one .json per entry
 *
 * Naming convention:
 *   File-mode entries  : {sanitised_filename}_{local_datetime}.{ext}
 *   Generated entries  : GENERATED_{FORMAT}_{local_datetime}.{ext}
 *   ZIP archives       : GENERATED_{CATEGORY}_{local_datetime}.zip
 */

import { openDB, getOutputBuffer } from '../lib/idb.js';

// ── State ──────────────────────────────────────
let rawText = '';
let parsedSections = []; // [{filename, format, rows[], cleanContent, rawContent}]
let currentView = 'text';

// ── Init ───────────────────────────────────────
async function init() {
  try {
    await openDB();
    rawText = await getOutputBuffer();

    if (!rawText || rawText.trim() === '') {
      showEmpty();
      return;
    }

    parsedSections = parseOutput(rawText);
    setStatus(`${parsedSections.length} section(s) — ${(new Blob([rawText]).size / 1024).toFixed(1)} KB`);

    renderText();
    attachControls();

  } catch (err) {
    setStatus('Error loading data: ' + err.message);
    console.error('[Viewer]', err);
  }
}

// ── Parsers ────────────────────────────────────

/**
 * Splits raw content by markdown code fences and parses each block.
 * Returns an array of parsed section objects.
 */
function detectAndParseSections(rawContent) {
  const results = [];
  const mdRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;
  let lastIndex = 0;

  while ((match = mdRegex.exec(rawContent)) !== null) {
    // 1. Parse text before the code block
    const textBefore = rawContent.substring(lastIndex, match.index).trim();
    if (textBefore) {
      results.push(detectAndParseSingleSection(textBefore, null, textBefore));
    }

    // 2. Parse the code block itself
    const lang = (match[1] || 'text').toLowerCase();
    const cleanContent = match[2].trim();
    if (cleanContent) {
      results.push(detectAndParseSingleSection(cleanContent, lang, match[0]));
    }

    lastIndex = mdRegex.lastIndex;
  }

  // 3. Parse text after the last code block (or the whole thing if no blocks found)
  const textAfter = rawContent.substring(lastIndex).trim();
  if (textAfter) {
    results.push(detectAndParseSingleSection(textAfter, null, textAfter));
  }

  return results;
}

/**
 * Cleans and detects format (JSON, CSV, Markdown Table, Text, Code) for a single block
 */
function detectAndParseSingleSection(content, explicitLang, rawText) {
  content = content.trim();

  // Try JSON
  if (!explicitLang || explicitLang === 'json') {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') {
        const headers = Object.keys(parsed[0]);
        const rows = [headers];
        for (const obj of parsed) {
          rows.push(headers.map(h => obj[h] !== undefined && obj[h] !== null ? String(obj[h]) : ''));
        }
        return { format: 'json', rows, cleanContent: content, rawContent: rawText };
      } else if (typeof parsed === 'object' && parsed !== null) {
        const rows = [['Key', 'Value']];
        for (const [k, v] of Object.entries(parsed)) {
          rows.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
        }
        return { format: 'json', rows, cleanContent: content, rawContent: rawText };
      }
    } catch (e) {}
  }

  // Try Markdown Table
  if (!explicitLang || explicitLang === 'md' || explicitLang === 'markdown' || explicitLang === 'md_table') {
    const mdLines = content.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
    if (mdLines.length >= 2) {
      const rows = [];
      for (const line of mdLines) {
        if (/^\|[\s\-:|]+\|/.test(line)) continue;
        const cols = line.split('|').slice(1, -1).map(c => c.trim());
        if (cols.length > 0) rows.push(cols);
      }
      if (rows.length > 0) {
        return { format: 'md_table', rows, cleanContent: content, rawContent: rawText };
      }
    }
  }

  // Try CSV
  if (!explicitLang || explicitLang === 'csv') {
    const csvLines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (csvLines.length >= 2) {
      const splitCsvLine = (line) => {
        const regex = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/;
        return line.split(regex).map(s => {
          s = s.trim();
          if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
          return s;
        });
      };
      const firstRow = splitCsvLine(csvLines[0]);
      if (firstRow.length > 1) {
        let isCsv = true;
        const rows = [firstRow];
        for (let i = 1; i < csvLines.length; i++) {
          const cols = splitCsvLine(csvLines[i]);
          if (cols.length !== firstRow.length) { isCsv = false; break; }
          rows.push(cols);
        }
        if (isCsv) return { format: 'csv', rows, cleanContent: content, rawContent: rawText };
      }
    }
  }

  // Default → explicit language or raw text
  return { format: explicitLang || 'text', rows: [], cleanContent: content, rawContent: rawText };
}

/**
 * Parses the full output buffer into sections.
 * @returns {Array<{filename:string, format:string, rows:string[][], cleanContent:string, rawContent:string}>}
 */
function parseOutput(text) {
  const sections = [];
  const lines = text.split('\n');

  let currentFile = 'Extracted Data';
  let currentBuffer = [];

  const flush = () => {
    if (currentBuffer.length > 0) {
      const rawSection = currentBuffer.join('\n');
      if (rawSection.trim()) {
        const parsedItems = detectAndParseSections(rawSection);
        
        for (let i = 0; i < parsedItems.length; i++) {
          const parsed = parsedItems[i];
          let finalFilename = currentFile;
          
          if (currentFile === 'Extracted Data' || currentFile === 'GENERATED') {
            const dtStamp = localDateTimeStamp();
            const fmt = (parsed.format || 'TEXT').toUpperCase().replace('MD_TABLE', 'TABLE').replace('MD', 'MARKDOWN');
            const ext = formatToExt(parsed.format);
            const idxStr = parsedItems.length > 1 ? `_${i + 1}` : '';
            finalFilename = `GENERATED_${fmt}${idxStr}_${dtStamp}.${ext}`;
          } else if (parsedItems.length > 1) {
            const base = currentFile.replace(/\.[^.]+$/, '');
            const extMatch = currentFile.match(/\.[^.]+$/);
            const ext = extMatch ? extMatch[0] : '';
            finalFilename = `${base}_${i + 1}${ext}`;
          }

          sections.push({
            filename: finalFilename,
            format: parsed.format,
            rows: parsed.rows,
            cleanContent: parsed.cleanContent,
            rawContent: parsed.rawContent,
          });
        }
      }
      currentBuffer = [];
    }
  };

  for (let line of lines) {
    if (line.startsWith('FILE: ')) {
      flush();
      currentFile = line.substring(6).trim();
    } else if (line.startsWith('====') || line.startsWith('----')) {
      continue;
    } else {
      currentBuffer.push(line);
    }
  }
  flush();
  return sections;
}

function buildAllRows() {
  const all = [];
  for (const sec of parsedSections) {
    for (const row of sec.rows) all.push([sec.filename, ...row]);
  }
  return all;
}

function buildJSON() {
  const out = {};
  for (const sec of parsedSections) {
    if (sec.rows.length === 0) continue;
    const headers = sec.rows[0];
    const data = sec.rows.slice(1).map(r => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i] ?? ''; });
      return obj;
    });
    if (!out[sec.filename]) out[sec.filename] = [];
    out[sec.filename].push(...data);
  }
  return out;
}

// ── Naming Helpers ─────────────────────────────

/** Returns a local datetime string suitable for filenames: DD-MMM-YYYY_HH-MM-SS */
function localDateTimeStamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${pad(date.getDate())}-${months[date.getMonth()]}-${date.getFullYear()}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/**
 * Returns true if the section's filename looks like a real source file
 * (has a file extension, or is not the generic default).
 */
function isFileModeSec(sec) {
  const name = sec.filename || '';
  if (name.startsWith('GENERATED_')) return false;
  return name !== 'Extracted Data' && name !== 'GENERATED' && name !== '' && /\.\w{1,6}$/.test(name);
}

/** Maps a detected format/language to a file extension. */
function formatToExt(format) {
  const map = {
    python: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts',
    json: 'json', html: 'html', css: 'css', markdown: 'md', md: 'md',
    csv: 'csv', sql: 'sql', bash: 'sh', shell: 'sh', sh: 'sh',
    xml: 'xml', yaml: 'yaml', yml: 'yaml', java: 'java', cpp: 'cpp',
    c: 'c', rust: 'rs', go: 'go', ruby: 'rb', php: 'php',
    md_table: 'md', text: 'txt',
  };
  return map[format?.toLowerCase()] || 'txt';
}

/** Sanitises a string for safe use as a filename component. */
function sanitise(str) {
  return str.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').slice(0, 60);
}

/**
 * Builds the base filename (without extension) for a single section.
 *
 * File-mode  : {sanitised_source_filename_no_ext}_{local_datetime}
 * Generated  : GENERATED_{FORMAT}_{local_datetime}
 */
function buildEntryBaseName(sec, dtStamp) {
  const name = sec.filename || '';
  if (name.startsWith('GENERATED_')) {
    // Already has full generated name & timestamp from parse-time. Just strip extension.
    return name.replace(/\.[^.]+$/, '');
  }
  if (isFileModeSec(sec)) {
    // Strip extension from source filename, sanitise
    const base = name.replace(/\.[^.]+$/, '');
    return `${sanitise(base)}_${dtStamp}`;
  }
  const fmt = (sec.format || 'TEXT').toUpperCase().replace('MD_TABLE', 'TABLE').replace('MD', 'MARKDOWN');
  return `GENERATED_${fmt}_${dtStamp}`;
}

/** Builds the ZIP archive name for a category. */
function buildZipName(category, dtStamp) {
  return `GENERATED_${category.toUpperCase()}_${dtStamp}.zip`;
}

// ── Renderers ──────────────────────────────────

function showEmpty() {
  setStatus('No output data yet — run the automation first.');
  document.getElementById('viewer-content').innerHTML = `
    <div class="viewer-empty">
      <div class="viewer-empty-icon">📭</div>
      <div class="viewer-empty-text">No output data found</div>
    </div>`;
}

function renderText() {
  const el = document.getElementById('output-text');
  el.textContent = rawText || '(empty)';
  showPane('output-text');
  currentView = 'text';
}

/** Renders every section as a highlight.js markdown code block. */
function renderMarkdown() {
  const container = document.getElementById('output-md');
  container.innerHTML = '';
  let hasContent = false;

  parsedSections.forEach((sec) => {
    if (!sec.cleanContent) return;
    hasContent = true;

    // ── Outer wrapper ──
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-bottom:24px;border-radius:8px;overflow:hidden;border:1px solid #3e4451;background:#282c34;box-shadow:0 4px 6px rgba(0,0,0,0.3);';

    // ── Header bar ──
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 16px;background:#21252b;border-bottom:1px solid #181a1f;';

    const title = document.createElement('div');
    title.textContent = sec.filename;
    title.style.cssText = 'color:#abb2bf;font-size:13px;font-weight:500;font-family:Inter,sans-serif;';

    const badge = document.createElement('span');
    badge.textContent = 'MARKDOWN';
    badge.style.cssText = 'font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:.05em;background:rgba(99,102,241,.18);color:#818cf8;';

    header.appendChild(title);
    header.appendChild(badge);

    // ── Code area ──
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:16px;overflow-x:auto;';

    const code = document.createElement('code');
    code.className = 'language-markdown';
    code.style.cssText = "font-family:'JetBrains Mono','Consolas',monospace;font-size:13.5px;line-height:1.6;";
    code.textContent = sec.cleanContent;

    pre.appendChild(code);
    wrap.appendChild(header);
    wrap.appendChild(pre);
    container.appendChild(wrap);

    if (window.hljs) hljs.highlightElement(code);
  });

  if (!hasContent) {
    container.innerHTML = '<p style="color:var(--text3);padding:20px;">(empty)</p>';
  }

  showPane('output-md');
  currentView = 'md';
}

function renderTable() {
  const container = document.getElementById('output-table');

  if (parsedSections.length === 0) {
    container.innerHTML = '<p style="color:#4a4a62;padding:20px;">No table data found in the output.</p>';
    showPane('output-table');
    currentView = 'table';
    return;
  }

  let html = '';
  for (const sec of parsedSections) {
    if (sec.rows.length === 0) continue;
    let badgeText = sec.format.toUpperCase().replace('_', ' ');
    html += `<div class="table-file-section">
      <div class="table-file-heading">
        📄 ${escHtml(sec.filename)}
        <span class="format-badge format-${sec.format}">${badgeText}</span>
      </div>
      <table><thead><tr>`;

    const headers = sec.rows[0];
    headers.forEach(h => { html += `<th>${escHtml(h)}</th>`; });
    html += '</tr></thead><tbody>';

    sec.rows.slice(1).forEach(row => {
      html += '<tr>';
      row.forEach(cell => { html += `<td>${escHtml(cell)}</td>`; });
      html += '</tr>';
    });

    html += '</tbody></table></div>';
  }

  container.innerHTML = html || '<p style="color:#4a4a62;padding:20px;">No rows found.</p>';
  showPane('output-table');
  currentView = 'table';
}

function renderJSON() {
  const el = document.getElementById('output-json');
  el.textContent = JSON.stringify(buildJSON(), null, 2);
  showPane('output-json');
  if (window.hljs) hljs.highlightElement(el);
  currentView = 'json';
}

const supportedLangs = ['python', 'javascript', 'typescript', 'json', 'html', 'css',
  'markdown', 'csv', 'sql', 'bash', 'xml', 'yaml', 'java', 'cpp', 'rust', 'go', 'ruby', 'php', 'text'];

function renderCodeBlock() {
  const el = document.getElementById('output-code');
  el.innerHTML = '';
  let hasContent = false;

  parsedSections.forEach((sec) => {
    if (!sec.cleanContent) return;
    hasContent = true;

    let lang = sec.format || 'text';
    if (lang === 'md_table') lang = 'markdown';

    const container = document.createElement('div');
    container.style.cssText = 'margin-bottom:24px;border-radius:8px;overflow:hidden;border:1px solid #3e4451;background:#282c34;box-shadow:0 4px 6px rgba(0,0,0,0.3);';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 16px;background:#21252b;border-bottom:1px solid #181a1f;';

    const title = document.createElement('div');
    title.textContent = sec.filename;
    title.style.cssText = 'color:#abb2bf;font-size:13px;font-weight:500;font-family:Inter,sans-serif;';

    const langSelect = document.createElement('select');
    langSelect.style.cssText = 'background:#181a1f;color:#abb2bf;border:1px solid #3e4451;border-radius:4px;padding:4px 8px;font-size:12px;outline:none;cursor:pointer;';

    const options = new Set([...supportedLangs, lang]);
    options.forEach(opt => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt.charAt(0).toUpperCase() + opt.slice(1);
      if (opt === lang) option.selected = true;
      langSelect.appendChild(option);
    });

    header.appendChild(title);
    header.appendChild(langSelect);

    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:16px;overflow-x:auto;';

    const code = document.createElement('code');
    code.className = `language-${lang}`;
    code.style.cssText = "font-family:'JetBrains Mono','Consolas',monospace;font-size:13.5px;line-height:1.5;";
    code.textContent = sec.cleanContent;

    pre.appendChild(code);
    container.appendChild(header);
    container.appendChild(pre);
    el.appendChild(container);

    if (window.hljs) hljs.highlightElement(code);

    langSelect.addEventListener('change', (e) => {
      const newLang = e.target.value;
      code.className = `language-${newLang}`;
      code.removeAttribute('data-highlighted');
      if (window.hljs) hljs.highlightElement(code);
    });
  });

  if (!hasContent) {
    el.textContent = '(empty)';
    el.style.color = 'var(--text-muted)';
  }

  showPane('output-code');
  currentView = 'code';
}

function showPane(id) {
  ['output-text', 'output-md', 'output-code', 'output-table', 'output-json'].forEach(pid => {
    const el = document.getElementById(pid);
    if (el) el.style.display = pid === id ? (id === 'output-text' || id === 'output-json' ? 'block' : 'block') : 'none';
  });
}

// ── Download Logic ─────────────────────────────

/**
 * Creates and triggers download of a Blob as a file.
 * @param {Blob} blob
 * @param {string} filename
 */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}

/**
 * Builds a rows-array CSV string from a 2D array.
 * @param {string[][]} rows
 * @returns {string}
 */
function rowsToCSV(rows) {
  return rows.map(r => r.map(c => {
    const str = String(c ?? '');
    return (str.includes(',') || str.includes('"') || str.includes('\n'))
      ? `"${str.replace(/"/g, '""')}"` : str;
  }).join(',')).join('\n');
}

/**
 * Converts rows to an Excel Blob using SheetJS.
 * @param {string[][]} rows
 * @returns {Blob|null}
 */
function rowsToXLSX(rows) {
  if (typeof XLSX === 'undefined') return null;
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([wbout], { type: 'application/octet-stream' });
}

/**
 * Shows a small inline modal asking the user to pick CSV or Excel.
 * Resolves with 'csv' or 'xlsx', or null if dismissed.
 * @returns {Promise<'csv'|'xlsx'|null>}
 */
function promptTableFormat() {
  return new Promise((resolve) => {
    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.id = 'fmt-modal-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(3px);z-index:1000;display:flex;align-items:center;justify-content:center;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:#1a1a26;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:28px 32px;min-width:260px;box-shadow:0 20px 60px rgba(0,0,0,.6);text-align:center;';

    const heading = document.createElement('div');
    heading.textContent = '📥 Choose Download Format';
    heading.style.cssText = 'font-size:15px;font-weight:700;color:#f0f0f6;margin-bottom:8px;';

    const sub = document.createElement('div');
    sub.textContent = 'Each table entry will be saved as a separate file in a ZIP archive.';
    sub.style.cssText = 'font-size:11.5px;color:#8b8ba8;margin-bottom:22px;line-height:1.5;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';

    const makeBtn = (label, value, accent) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = `padding:9px 22px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid ${accent};background:transparent;color:${accent};font-family:inherit;transition:all .15s;`;
      btn.onmouseenter = () => btn.style.background = accent + '22';
      btn.onmouseleave = () => btn.style.background = 'transparent';
      btn.addEventListener('click', () => { cleanup(); resolve(value); });
      return btn;
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'margin-top:14px;background:none;border:none;color:#4a4a62;font-size:12px;cursor:pointer;font-family:inherit;';
    cancelBtn.addEventListener('click', () => { cleanup(); resolve(null); });

    btnRow.appendChild(makeBtn('⬇ CSV', 'csv', '#f59e0b'));
    btnRow.appendChild(makeBtn('⬇ Excel', 'xlsx', '#10b981'));

    modal.appendChild(heading);
    modal.appendChild(sub);
    modal.appendChild(btnRow);
    modal.appendChild(cancelBtn);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const cleanup = () => { backdrop.remove(); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { cleanup(); resolve(null); } });
  });
}

/**
 * Main download dispatcher.
 * @param {string} view  — 'text'|'md'|'code'|'table'|'json'
 */
async function downloadCategory(view) {
  if (parsedSections.length === 0 && !rawText) {
    alert('No output data to download.');
    return;
  }

  const dt = localDateTimeStamp();

  // ── TEXT: single file ──────────────────────────────────────────────────────
  if (view === 'text') {
    const blob = new Blob([rawText || ''], { type: 'text/plain;charset=utf-8' });
    triggerDownload(blob, `GENERATED_TEXT_${dt}.txt`);
    return;
  }

  // ── Require JSZip for everything else ──────────────────────────────────────
  if (typeof JSZip === 'undefined') {
    alert('JSZip library not loaded — cannot create ZIP.');
    return;
  }

  // ── TABLE: ask format first ────────────────────────────────────────────────
  if (view === 'table') {
    const fmt = await promptTableFormat();
    if (!fmt) return;

    const zip = new JSZip();
    let count = 0;

    for (const sec of parsedSections) {
      if (!sec.rows || sec.rows.length < 2) continue;
      const baseName = buildEntryBaseName(sec, dt);
      const fileName = `${baseName}.${fmt}`;

      if (fmt === 'csv') {
        zip.file(fileName, rowsToCSV(sec.rows));
      } else {
        const blob = rowsToXLSX(sec.rows);
        if (!blob) { alert('SheetJS not loaded — Excel export unavailable.'); return; }
        zip.file(fileName, blob);
      }
      count++;
    }

    if (count === 0) { alert('No table entries found.'); return; }
    const content = await zip.generateAsync({ type: 'blob' });
    triggerDownload(content, buildZipName('TABLES', dt));
    return;
  }

  // ── MARKDOWN ───────────────────────────────────────────────────────────────
  if (view === 'md') {
    const zip = new JSZip();
    let count = 0;

    for (const sec of parsedSections) {
      if (!sec.cleanContent) continue;
      const baseName = buildEntryBaseName(sec, dt);
      zip.file(`${baseName}.md`, sec.cleanContent);
      count++;
    }

    if (count === 0) { alert('No markdown entries found.'); return; }
    const content = await zip.generateAsync({ type: 'blob' });
    triggerDownload(content, buildZipName('MARKDOWN', dt));
    return;
  }

  // ── CODE BLOCK ────────────────────────────────────────────────────────────
  if (view === 'code') {
    const zip = new JSZip();
    let count = 0;

    for (const sec of parsedSections) {
      if (!sec.cleanContent) continue;
      const lang = sec.format === 'md_table' ? 'markdown' : (sec.format || 'text');
      const ext = formatToExt(lang);
      const baseName = buildEntryBaseName(sec, dt);
      zip.file(`${baseName}.${ext}`, sec.cleanContent);
      count++;
    }

    if (count === 0) { alert('No code entries found.'); return; }
    const content = await zip.generateAsync({ type: 'blob' });
    triggerDownload(content, buildZipName('CODEBLOCKS', dt));
    return;
  }

  // ── JSON ───────────────────────────────────────────────────────────────────
  if (view === 'json') {
    const zip = new JSZip();
    let count = 0;

    for (const sec of parsedSections) {
      if (!sec.cleanContent) continue;

      // Try to re-parse as JSON for pretty-printing, fall back to raw
      let jsonStr;
      try {
        jsonStr = JSON.stringify(JSON.parse(sec.cleanContent), null, 2);
      } catch {
        // If section itself isn't JSON, wrap it
        jsonStr = JSON.stringify({ content: sec.cleanContent }, null, 2);
      }

      const baseName = buildEntryBaseName(sec, dt);
      zip.file(`${baseName}.json`, jsonStr);
      count++;
    }

    if (count === 0) { alert('No JSON entries found.'); return; }
    const content = await zip.generateAsync({ type: 'blob' });
    triggerDownload(content, buildZipName('JSON', dt));
    return;
  }
}

// ── Controls ───────────────────────────────────

function attachControls() {
  document.getElementById('view-text').addEventListener('click', () => {
    setActive('view-text');
    renderText();
  });

  document.getElementById('view-md').addEventListener('click', () => {
    setActive('view-md');
    renderMarkdown();
  });

  document.getElementById('view-code').addEventListener('click', () => {
    setActive('view-code');
    renderCodeBlock();
  });

  document.getElementById('view-table').addEventListener('click', () => {
    setActive('view-table');
    renderTable();
  });

  document.getElementById('view-json').addEventListener('click', () => {
    setActive('view-json');
    renderJSON();
  });

  document.getElementById('download-current')?.addEventListener('click', () => {
    downloadCategory(currentView);
  });
}

function setActive(btnId) {
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(btnId)?.classList.add('active');
}

// ── Helpers ────────────────────────────────────

function setStatus(msg) {
  const el = document.getElementById('viewer-status');
  if (el) el.textContent = msg;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Bootstrap ──────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
