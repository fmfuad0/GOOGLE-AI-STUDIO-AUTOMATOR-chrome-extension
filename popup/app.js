/**
 * @fileoverview Popup / SidePanel Application Logic — AI Studio Automator
 * Manages UI state, IndexedDB interactions, profile CRUD,
 * spreadsheet file management, and communication with the background service worker.
 * AI Studio only.
 */

import {
  openDB,
  addFile,
  getAllFiles,
  deleteFile,
  clearInputFiles,
  getConfig,
  setConfig,
  getOutputBuffer,
  clearOutputBuffer,
  updateFile,
} from '../lib/idb.js';

// ─────────────────────────────────────────────
// Constants & module state
// ─────────────────────────────────────────────

const DEFAULT_PROMPT = "### System Prompt\n\n**Role:**  \nYou are an expert OCR (Optical Character Recognition) specialist natively fluent in Bengali, paired with a meticulous data formatting assistant. Your primary strength is \"deep reading\" complex Bengali text to ensure zero spelling errors, especially with similar-looking words and conjuncts (যুক্তাক্ষর).\n\n**Objective:**  \nYour task is to carefully analyze one or multiple Bengali PDF documents containing Table of Contents pages, extract the hierarchical structure of the list from each file, and format the extracted TOC data into a specific 3-column Markdown table.\n\n---\n\n## Instructions\n\n### 1. Multiple PDF Handling\n\n* I may provide multiple PDF documents with this prompt.\n* You must process **each PDF separately**.\n* For every PDF, first mention the **exact filename** as an H1 heading.\n* Then provide the respective extracted TOC data for that file.\n* Do not mix TOC entries from different PDF files.\n* Repeat this structure for every PDF:\n\n    # [Exact PDF Filename]\n\n    | col1 | col2 | col 3 |\n    | :--- | :--- | :--- |\n    | ... | ... | ... |\n\n---\n\n### 2. Deep OCR & Accuracy\n\n* Do not perform rushed OCR.\n* Inspect the PDF pages carefully, word-by-word.\n* Pay intense attention to Bengali spelling nuances, diacritics, and complex characters.\n* Carefully differentiate similar-looking Bengali words and conjuncts.\n* Maintain the original Bengali script.\n* Do not transliterate into English unless explicitly asked.\n* Preserve the exact Bengali wording of the Table of Contents.\n* Do not add, summarize, modernize, or correct the original text unless there is an obvious OCR artifact.\n\n---\n\n### 3. Determine the Hierarchy & Numbering Logic\n\n* **Level 1 — Root Sections:**  \n  Identify top-level headings. Assign them an overarching sequential integer: `1`, `2`, `3`, `4`, etc.\n\n* **Level 2 — Numbered Items:**  \n  Identify lists numbered in Bengali. Map these to their root section using decimal format:\n\n  `[Root].1`, `[Root].2`, `[Root].3`\n\n* **Level 1 Without Children:**  \n  If a Level 1 item has no children, represent its number as `[Root].0`\n\n* **Level 3 — Bullet Points:**  \n  Identify sub-items. Add another decimal layer sequentially:\n  `[Root].[Level2].[Level3]`\n\n---\n\n### 4. Output Format\n\n* Format the output exactly as a standard Markdown table.\n* Use exactly these column headers:\n\n    | col1 | col2 | col 3 |\n    | :--- | :--- | :--- |\n\n* **col1:** Output only the Root integer, such as `1`, `2`, `4`.\n* **col2:** Output the exact hierarchical decimal number, such as `1.0`, `4.1`, `4.13.1`.\n* **col 3:** Output the flawlessly transcribed Bengali text.\n* Do not include page numbers unless they are part of the TOC title text itself.\n* Do not add any extra columns.\n\n---\n\n### 5. Strict Constraints\n\n* Output only the H1 filename and the Markdown table for each PDF.\n* Do not include greetings, explanations, comments, notes, or analysis.\n* If a word is unreadable, write `[অস্পষ্ট]` only for that word.\n* Stop immediately after the last table ends.";

/** Built-in demo profiles always available in the dropdown */
const BUILT_IN_PROFILES = [
  {
    id:   '__builtin_json__',
    name: '🔷 Demo — JSON Format',
    prompt: `Generate a demo dataset representing a fictional tech company's employee directory. Include the company name, location, and an array of 3 employees. Each employee should have an ID (integer), Name (string), Role (string), and Remote Status (boolean).

**CRITICAL INSTRUCTIONS:** Output ONLY valid JSON. Do not include any conversational filler, markdown formatting, or explanations before or after the JSON object. Start with \`{\` and end with \`}\`.`,
  },
  {
    id:   '__builtin_table__',
    name: '📊 Demo — Table Format',
    prompt: `Create a demo inventory list for a fantasy adventure shop. Format the output strictly as a Markdown table.

The table must have exactly these four columns: 'Item Name', 'Category', 'Quantity', and 'Price (Gold)'. Generate exactly 5 rows of creative fictional items. Do not output anything else besides the table.`,
  },
  {
    id:   '__builtin_markdown__',
    name: 'Ⓜ️ Demo — Markdown Format',
    prompt: `Create a short demo document titled 'Project Alpha Overview'. You must use rich Markdown formatting to structure the document.

Include the following Markdown elements:
- An H1 Header for the title.
- An H2 Header for a 'Features' section.
- An unordered bulleted list of 3 features.
- An ordered numbered list of 3 next steps.
- At least one sentence utilizing **bold** text and another using *italic* text.
- A blockquote containing a fictional quote from the CEO.
Output only the formatted Markdown.`,
  },
  {
    id:   '__builtin_code__',
    name: '💻 Demo — Code Block Format',
    prompt: `Write a simple Python script that takes a list of numbers and returns only the even numbers. Include brief comments explaining how the code works.

**CRITICAL INSTRUCTIONS:** Output the entire response inside a single Python Markdown code block (using three backticks). Do not write any conversational text outside of the code block. All explanations must be comments inside the code block itself.`,
  },
  {
    id:   '__builtin_demo_all__',
    name: '📚 Demo — All Code Block Formats',
    prompt: `Please generate a basic, concise code sample (such as a "Hello World" or a simple representative snippet) for every programming language and data format in the list below. 

Your main goal is to format every single output strictly using Markdown code blocks with the correct language identifier for syntax highlighting. Do not include any conversational text between the blocks; only output the markdown code blocks.

Format Example:
\`\`\`python
print("Hello World")
\`\`\`
\`\`\`javascript
console.log("Hello World");
\`\`\`

Here is the complete list of languages and formats to extract samples for:
- Python
- Javascript
- Typescript
- Json
- Html
- Css
- Markdown
- Csv
- Sql
- Bash
- Xml
- Yaml
- Java
- Cpp
- Rust
- Go
- Ruby
- Php
- Text`,
  },
];

/** @type {Array<{id:string, name:string, prompt:string}>} */
let profiles = [];
let activeProfileId = null;
let currentJobState = 'IDLE';

// ─────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────

/**
 * Entry point: called once on DOMContentLoaded.
 * Warms up DB, loads config, renders UI, attaches listeners.
 */
async function init() {
  try {
    await openDB();
    await loadProfiles();
    await renderFileList();
    await refreshOutputInfo();
    setupEventListeners();
    setupMessageListener();
    requestCurrentStatus();

    // Re-render file list every 5 seconds to update elapsed time while running
    setInterval(() => {
      if (currentJobState === 'RUNNING') renderFileList();
    }, 5000);

    // Restore Excel UI state from persisted settings
    const files = await getAllFiles();
    const pendingExcel = files.find(f =>
      f.status === 'pending' &&
      (f.name.toLowerCase().endsWith('.xlsx') ||
       f.name.toLowerCase().endsWith('.csv')  ||
       f.name.toLowerCase().endsWith('.xls'))
    );
    if (pendingExcel) {
      try {
        const workbook = XLSX.read(pendingExcel.fileData, { type: 'array' });
        populateExcelSelectors(workbook);
      } catch (e) {
        console.error('[Popup] Failed to parse pending Excel for state restoration', e);
      }
    }
    await loadExcelSettings();
    await setupInputMode();

  } catch (err) {
    console.error('[Popup] init error:', err);
  }
}

// ─────────────────────────────────────────────
// Profile Management
// ─────────────────────────────────────────────

/**
 * Loads profiles from IndexedDB and renders the profile selector.
 * Creates a default profile if none exist.
 */
async function loadProfiles() {
  try {
    let stored = await getConfig('profiles');
    activeProfileId = await getConfig('activeProfile');

    if (!stored || stored.length === 0) {
      const defaultProfile = {
        id:     'default-' + Date.now(),
        name:   '📄 Table Extractor',
        prompt: DEFAULT_PROMPT,
      };
      stored = [defaultProfile];
      await setConfig('profiles', stored);
      activeProfileId = defaultProfile.id;
      await setConfig('activeProfile', activeProfileId);
    }

    // Add icons to any existing profile names that don't have one
    let migrated = false;
    for (const p of stored) {
      const firstChar = Array.from(p.name.trim())[0];
      if (firstChar && firstChar.charCodeAt(0) < 1000) {
        if (p.name.trim() === 'Table Extractor') {
          p.name = '📄 Table Extractor';
        } else {
          p.name = '📝 ' + p.name;
        }
        migrated = true;
      }
    }
    if (migrated) {
      await setConfig('profiles', stored);
    }

    // Merge built-in profiles — add any that are missing (never overwrite)
    const storedIds = new Set(stored.map(p => p.id));
    for (const bp of BUILT_IN_PROFILES) {
      if (!storedIds.has(bp.id)) {
        stored.push(bp);
        migrated = true;
      }
    }
    profiles = stored;
    if (migrated) await setConfig('profiles', profiles);

    if (!activeProfileId || !profiles.find(p => p.id === activeProfileId)) {
      activeProfileId = profiles[0].id;
      await setConfig('activeProfile', activeProfileId);
    }

    renderProfiles();
  } catch (err) {
    console.error('[Popup] loadProfiles error:', err);
  }
}

/** Renders profile options into the select element. */
function renderProfiles() {
  const sel = document.getElementById('profile-select');
  if (!sel) return;

  sel.innerHTML = '';
  profiles.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === activeProfileId) opt.selected = true;
    sel.appendChild(opt);
  });

  updatePromptPreview();
}

/** Updates the prompt textarea to reflect the selected profile. */
function updatePromptPreview() {
  const preview = document.getElementById('prompt-preview');
  if (!preview) return;
  const profile = profiles.find(p => p.id === activeProfileId);
  preview.value = profile ? profile.prompt : '';
}

// ─────────────────────────────────────────────
// File Rendering
// ─────────────────────────────────────────────

/**
 * Formats bytes into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' MB';
  if (bytes >= 1_024)     return Math.round(bytes / 1_024) + ' KB';
  return bytes + ' B';
}

/**
 * Truncates a filename to a max character length.
 * @param {string} name
 * @param {number} max
 * @returns {string}
 */
function truncateName(name, max = 30) {
  if (name.length <= max) return name;
  const ext = name.lastIndexOf('.');
  if (ext > 0) {
    const suffix = name.slice(ext);
    return name.slice(0, max - suffix.length - 3) + '...' + suffix;
  }
  return name.slice(0, max - 3) + '...';
}

/** Fetches all files from IndexedDB and renders the file list. */
async function renderFileList() {
  try {
    const files   = await getAllFiles();
    const listEl  = document.getElementById('file-list');
    const badge   = document.getElementById('file-count-badge');
    const actionsEl = document.getElementById('file-list-actions');

    if (!listEl) return;

    // Filter to supported files only
    const validFiles = files.filter(f => {
      const n = f.name.toLowerCase();
      return n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.csv') || n.endsWith('.pdf');
    });

    badge.textContent = validFiles.length;
    actionsEl.style.display = validFiles.length > 0 ? 'block' : 'none';

    if (validFiles.length === 0) {
      listEl.innerHTML = '<div class="file-list-empty">No files added yet.</div>';
      return;
    }

    listEl.innerHTML = '';
    validFiles.forEach(file => {
      const item = document.createElement('div');
      item.className = 'file-item';
      item.setAttribute('role', 'listitem');
      item.dataset.id = file.id;

      let timeText = '';
      if (file.startTime && file.status === 'processing') {
        const elapsed = Math.max(0, Math.floor((Date.now() - file.startTime) / 60000));
        timeText = `<span class="file-time">${elapsed}m</span>`;
      } else if (file.startTime && file.endTime) {
        const elapsed = Math.max(0, Math.floor((file.endTime - file.startTime) / 60000));
        timeText = `<span class="file-time">${elapsed}m</span>`;
      }

      const statusLabels = {
        processing: 'In Progress',
        processed:  'Completed',
        pending:    'Pending',
        sent:       'Sent',
        failed:     'Failed',
      };
      const statusLabel = statusLabels[file.status] || file.status;

      item.innerHTML = `
        <span class="file-status-dot status-${file.status || 'pending'}" title="${statusLabel}"></span>
        <span class="file-name" title="${file.name}">${truncateName(file.name)}</span>
        ${timeText}
        <span class="file-size">${formatSize(file.size)}</span>
        <button class="file-delete" data-id="${file.id}" title="Remove file" aria-label="Remove ${file.name}">✕</button>
      `;

      listEl.appendChild(item);
    });

    // Attach delete listeners
    listEl.querySelectorAll('.file-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteFile(Number(btn.dataset.id));
        await renderFileList();
      });
    });
  } catch (err) {
    console.error('[Popup] renderFileList error:', err);
  }
}

// ─────────────────────────────────────────────
// File Processing
// ─────────────────────────────────────────────

/**
 * Reads a list of File objects and saves them to IndexedDB.
 * Routes to spreadsheet or PDF processing based on the active input mode.
 * @param {FileList|File[]} fileList
 */
async function processFiles(fileList) {
  const mode = document.querySelector('input[name="input-mode"]:checked')?.value || 'spreadsheet';
  const files = Array.from(fileList);

  if (mode === 'pdf') {
    const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfs.length === 0) {
      alert('Please select valid PDF files (.pdf).');
      return;
    }
    for (const file of pdfs) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        await addFile(arrayBuffer, file.name, file.size, file.type || 'application/pdf');
      } catch (err) {
        console.error('[Popup] Failed to save PDF:', file.name, err);
      }
    }
    await renderFileList();
    return;
  }

  // Default: spreadsheet mode
  const spreadsheets = files.filter(f => {
    const n = f.name.toLowerCase();
    return n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.csv');
  });

  if (spreadsheets.length === 0) {
    alert('Please select valid spreadsheet files (.xlsx, .xls, .csv).');
    return;
  }

  for (const file of spreadsheets) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      await addFile(
        arrayBuffer,
        file.name,
        file.size,
        file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      // For the first file, populate the sheet and column selectors immediately
      if (file === spreadsheets[0]) {
        try {
          const workbook = XLSX.read(arrayBuffer, { type: 'array' });
          populateExcelSelectors(workbook);
        } catch (e) {
          console.error('[Popup] Failed to parse Excel for headers:', e);
        }
      }
    } catch (err) {
      console.error('[Popup] Failed to save spreadsheet:', file.name, err);
    }
  }

  await renderFileList();
}

// ─────────────────────────────────────────────
// Sheet & Column Selectors
// ─────────────────────────────────────────────

/**
 * Populates sheet and column selectors from a parsed XLSX workbook.
 * @param {XLSX.WorkBook} workbook
 */
function populateExcelSelectors(workbook) {
  const sheetSelect = document.getElementById('excel-sheet-select');
  const colSelector = document.getElementById('excel-column-selector');
  if (!sheetSelect || !colSelector) return;

  sheetSelect.innerHTML = '';
  sheetSelect.disabled = false;

  workbook.SheetNames.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sheetSelect.appendChild(opt);
  });

  // Keep reference globally for sheet switching
  window._currentWorkbook = workbook;

  const updateTotalRows = (sheetName) => {
    const ws = workbook.Sheets[sheetName];
    const el = document.getElementById('excel-total-rows');
    if (!ws || !el) return;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    el.textContent = `${rows.length} rows`;
  };

  const firstSheet = workbook.SheetNames[0];
  renderColumnsForSheet(firstSheet);
  updateTotalRows(firstSheet);

  sheetSelect.onchange = (e) => {
    const sheetName = e.target.value;
    renderColumnsForSheet(sheetName);
    saveExcelSettings();
    updateTotalRows(sheetName);
  };
}

/**
 * Renders column checkboxes for a specific sheet name.
 * @param {string} sheetName
 */
function renderColumnsForSheet(sheetName) {
  const colSelector = document.getElementById('excel-column-selector');
  if (!colSelector || !window._currentWorkbook) return;

  const worksheet = window._currentWorkbook.Sheets[sheetName];
  if (!worksheet) return;

  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  if (!rows || rows.length === 0) {
    colSelector.innerHTML = '<div class="empty-state-text">Sheet is empty</div>';
    return;
  }

  const headers = rows[0];
  colSelector.innerHTML = '';

  headers.forEach((h, idx) => {
    const colName = h ? String(h).trim() : `Column ${idx + 1}`;
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    label.innerHTML = `
      <input type="checkbox" value="${idx}" checked>
      <span>${colName}</span>
    `;
    label.querySelector('input').addEventListener('change', saveExcelSettings);
    colSelector.appendChild(label);
  });
}

// ─────────────────────────────────────────────
// Excel State Persistence
// ─────────────────────────────────────────────

async function saveExcelSettings() {
  const sheetSelect = document.getElementById('excel-sheet-select');
  const sheetName   = sheetSelect ? sheetSelect.value : '';

  const checkboxes      = document.querySelectorAll('#excel-column-selector input[type="checkbox"]');
  const selectedColumns = Array.from(checkboxes).filter(cb => cb.checked).map(cb => Number(cb.value));

  const rowsPerPrompt  = document.getElementById('excel-rows-per-prompt')?.value || 50;
  const includeHeaders = document.getElementById('excel-include-headers')?.checked ?? true;

  await setConfig('excelSettings', { sheetName, selectedColumns, rowsPerPrompt, includeHeaders });
}

async function loadExcelSettings() {
  const saved = await getConfig('excelSettings');
  if (!saved) return;

  const sheetSelect = document.getElementById('excel-sheet-select');
  if (sheetSelect && saved.sheetName) {
    sheetSelect.value = saved.sheetName;
    renderColumnsForSheet(saved.sheetName);
  }

  if (saved.selectedColumns) {
    const checkboxes = document.querySelectorAll('#excel-column-selector input[type="checkbox"]');
    checkboxes.forEach(cb => {
      cb.checked = saved.selectedColumns.includes(Number(cb.value));
    });
  }

  const rowsInput = document.getElementById('excel-rows-per-prompt');
  if (rowsInput && saved.rowsPerPrompt) rowsInput.value = saved.rowsPerPrompt;

  const includeHeaders = document.getElementById('excel-include-headers');
  if (includeHeaders && saved.includeHeaders !== undefined) includeHeaders.checked = saved.includeHeaders;
}

// ─────────────────────────────────────────────
// PDF State Persistence
// ─────────────────────────────────────────────

async function savePdfSettings() {
  const filesPerPrompt = document.getElementById('pdf-files-per-prompt')?.value || 1;
  await setConfig('pdfSettings', { filesPerPrompt });
}

async function loadPdfSettings() {
  const saved = await getConfig('pdfSettings');
  if (!saved) return;
  const filesInput = document.getElementById('pdf-files-per-prompt');
  if (filesInput && saved.filesPerPrompt) filesInput.value = saved.filesPerPrompt;
}

// ─────────────────────────────────────────────
// Input Mode
// ─────────────────────────────────────────────

/**
 * Loads persisted input mode & system prompt toggle,
 * and wires up the radio/toggle change listeners.
 */
async function setupInputMode() {
  const savedMode       = (await getConfig('inputMode')) || 'spreadsheet';
  const savedSysPrompt  = (await getConfig('addSystemPrompt')) ?? false;

  const radioSpreadsheet = document.getElementById('radio-spreadsheet');
  const radioPdf         = document.getElementById('radio-pdf');
  const radioRaw         = document.getElementById('radio-raw');
  const chkSys           = document.getElementById('chk-system-prompt');

  if (radioSpreadsheet && radioPdf && radioRaw) {
    if (savedMode === 'raw')         radioRaw.checked         = true;
    else if (savedMode === 'pdf')    radioPdf.checked         = true;
    else                             radioSpreadsheet.checked = true;
  }
  if (chkSys) chkSys.checked = savedSysPrompt;

  _applyInputMode(savedMode);

  document.querySelectorAll('input[name="input-mode"]').forEach(radio => {
    radio.addEventListener('change', async () => {
      const mode = document.querySelector('input[name="input-mode"]:checked')?.value || 'spreadsheet';
      // If switching modes, ask user if they want to clear the file queue
      const existingFiles = await getAllFiles().catch(() => []);
      const pendingFiles  = existingFiles.filter(f => f.status === 'pending');
      if (pendingFiles.length > 0) {
        if (confirm('Switching file type will clear the current file queue. Continue?')) {
          await clearInputFiles();
          await renderFileList();
        } else {
          // Revert radio selection
          const prevMode = await getConfig('inputMode') || 'spreadsheet';
          const prevRadio = document.getElementById(
            prevMode === 'raw' ? 'radio-raw' : prevMode === 'pdf' ? 'radio-pdf' : 'radio-spreadsheet'
          );
          if (prevRadio) prevRadio.checked = true;
          return;
        }
      }
      _applyInputMode(mode);
      await setConfig('inputMode', mode);
    });
  });

  document.getElementById('chk-system-prompt')?.addEventListener('change', async (e) => {
    await setConfig('addSystemPrompt', e.target.checked);
  });

  // Persist raw text on input
  document.getElementById('raw-input-text')?.addEventListener('input', async (e) => {
    await setConfig('rawInputText', e.target.value);
  });

  // Restore raw text
  const savedRaw = await getConfig('rawInputText');
  const rawTA = document.getElementById('raw-input-text');
  if (rawTA && savedRaw) rawTA.value = savedRaw;

  // ── Batch delay ─────────────────────────────────────────────────────────
  const savedDelay = (await getConfig('batchDelay')) ?? 0;
  const delayInput = document.getElementById('batch-delay-seconds');
  if (delayInput) delayInput.value = savedDelay;

  const _saveDelay = async () => {
    const v = Math.max(0, Math.min(300, Number(delayInput?.value) || 0));
    if (delayInput) delayInput.value = v;
    await setConfig('batchDelay', v);
  };

  document.getElementById('delay-inc')?.addEventListener('click', async () => {
    if (delayInput) delayInput.value = Math.min(300, (Number(delayInput.value) || 0) + 5);
    await _saveDelay();
  });
  document.getElementById('delay-dec')?.addEventListener('click', async () => {
    if (delayInput) delayInput.value = Math.max(0, (Number(delayInput.value) || 0) - 5);
    await _saveDelay();
  });
  delayInput?.addEventListener('change', _saveDelay);
}

/**
 * Updates the dropzone UI (icon, text, accept attr) to reflect the active input mode.
 * @param {'spreadsheet'|'pdf'|'raw'} mode
 */
function _updateDropzoneForMode(mode) {
  const fileInput       = document.getElementById('file-input');
  const folderInput     = document.getElementById('folder-input');
  const dropzoneIcon    = document.getElementById('dropzone-icon');
  const dropzoneText    = document.getElementById('dropzone-text');
  const folderSubText   = document.getElementById('dropzone-sub-folder');

  if (mode === 'pdf') {
    if (fileInput)     fileInput.accept  = '.pdf';
    if (folderInput)   folderInput.accept = '.pdf';
    if (dropzoneIcon)  dropzoneIcon.textContent  = '📄';
    if (dropzoneText)  dropzoneText.textContent  = 'Drop PDF files here';
    if (folderSubText) folderSubText.textContent = 'All contained PDF files will be queued';
  } else {
    if (fileInput)     fileInput.accept  = '.xlsx,.xls,.csv';
    if (folderInput)   folderInput.accept = '.xlsx,.xls,.csv';
    if (dropzoneIcon)  dropzoneIcon.textContent  = '📊';
    if (dropzoneText)  dropzoneText.textContent  = 'Drop Excel / CSV files here';
    if (folderSubText) folderSubText.textContent = 'All contained spreadsheet files will be queued';
  }
}

/**
 * Shows or hides file/raw sections based on selected mode.
 * @param {'spreadsheet'|'pdf'|'raw'} mode
 */
function _applyInputMode(mode) {
  const fileSection   = document.getElementById('file-input-section');
  const sheetSection  = document.getElementById('sheet-settings');
  const pdfSection    = document.getElementById('pdf-settings');
  const rawSection    = document.getElementById('raw-input-section');

  // Hide everything first, then show what's needed
  if (fileSection)  fileSection.style.display  = 'none';
  if (sheetSection) sheetSection.style.display = 'none';
  if (pdfSection)   pdfSection.style.display   = 'none';
  if (rawSection)   rawSection.style.display   = 'none';

  if (mode === 'raw') {
    if (rawSection) rawSection.style.display = 'block';
  } else if (mode === 'pdf') {
    if (fileSection) fileSection.style.display = 'block';
    if (pdfSection)  pdfSection.style.display  = 'block';
    _updateDropzoneForMode('pdf');
  } else {
    // spreadsheet (default)
    if (fileSection)  fileSection.style.display  = 'block';
    if (sheetSection) sheetSection.style.display = 'block';
    _updateDropzoneForMode('spreadsheet');
  }
}

// ─────────────────────────────────────────────
// Output Info
// ─────────────────────────────────────────────

async function refreshOutputInfo() {
  try {
    const text = await getOutputBuffer();
    const infoEl = document.getElementById('output-info');
    if (!infoEl) return;
    if (!text || text.trim() === '') {
      infoEl.textContent = 'No extracted data yet.';
      infoEl.style.color = '';
    } else {
      const lines  = text.split('\n').length;
      const sizeKB = (new Blob([text]).size / 1024).toFixed(1);
      infoEl.textContent = `Buffer: ~${lines} lines · ${sizeKB} KB ready to download`;
      infoEl.style.color = 'var(--success)';
    }
  } catch (err) {
    console.error('[Popup] refreshOutputInfo error:', err);
  }
}

// ─────────────────────────────────────────────
// Status Updates
// ─────────────────────────────────────────────

/**
 * Updates the status bar from a JOB_STATUS message.
 * @param {{state:string, processed:number, total:number, failed:number, runTime:number}} msg
 */
async function handleStatusUpdate(msg) {
  currentJobState = msg.state;

  const dotEl       = document.getElementById('status-dot');
  const textEl      = document.getElementById('status-text');
  const countsEl    = document.getElementById('status-counts');
  const progressWrap = document.getElementById('progress-wrap');
  const progressBar  = document.getElementById('progress-bar');

  if (dotEl) {
    dotEl.className = 'status-dot dot-' + (msg.state || 'idle').toLowerCase();
  }

  const stateLabels = {
    IDLE:    'Idle — Ready',
    RUNNING: 'Running automation...',
    PAUSED:  'Paused — Resume when ready',
    PAUSED_RETRYING: 'Rate limit — Auto-retrying...',
    ERROR:   'Error — Check AI Studio tab',
  };
  if (textEl) textEl.textContent = stateLabels[msg.state] || msg.state;

  if (countsEl && msg.total > 0) {
    countsEl.textContent = `${msg.processed}/${msg.total} (${msg.failed} ✗)`;
  } else if (countsEl) {
    countsEl.textContent = '';
  }

  if (progressWrap && progressBar && msg.total > 0) {
    progressWrap.style.display = 'block';
    progressBar.style.width = Math.round((msg.processed / msg.total) * 100) + '%';
  } else if (progressWrap && msg.state === 'IDLE') {
    progressWrap.style.display = 'none';
  }

  updateButtonStates(msg.state);
  await renderFileList();
  await refreshOutputInfo();
}

/**
 * Sets enabled/disabled state of action buttons based on job state.
 * @param {string} jobState
 */
function updateButtonStates(jobState) {
  const runBtn    = document.getElementById('btn-run');
  const pauseBtn  = document.getElementById('btn-pause');
  const resumeBtn = document.getElementById('btn-resume');
  const stopBtn   = document.getElementById('btn-stop');
  if (!runBtn) return;

  switch (jobState) {
    case 'RUNNING':
    case 'PAUSED_RETRYING':
      runBtn.disabled    = true;
      pauseBtn.disabled  = false;
      resumeBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      break;
    case 'PAUSED':
      runBtn.disabled    = true;
      pauseBtn.disabled  = true;
      resumeBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = false;
      break;
    default: // IDLE or ERROR
      runBtn.disabled    = false;
      pauseBtn.disabled  = true;
      resumeBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = true;
  }
}

/** Sends a GET_STATUS request to the background service worker. */
function requestCurrentStatus() {
  try {
    chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response) handleStatusUpdate(response);
    });
  } catch (err) {
    console.warn('[Popup] GET_STATUS failed:', err.message);
  }
}

// ─────────────────────────────────────────────
// Event Listeners
// ─────────────────────────────────────────────

function setupEventListeners() {

  // ── Dropzone setup ────────────────
  setupDropzone();

  // ── Tabs ──────────────────────────
  document.getElementById('tab-files')?.addEventListener('click', () => {
    document.getElementById('tab-files').classList.add('active');
    document.getElementById('tab-folder').classList.remove('active');
    document.getElementById('content-files').style.display = 'block';
    document.getElementById('content-folder').style.display = 'none';
  });

  document.getElementById('tab-folder')?.addEventListener('click', () => {
    document.getElementById('tab-folder').classList.add('active');
    document.getElementById('tab-files').classList.remove('active');
    document.getElementById('content-folder').style.display = 'block';
    document.getElementById('content-files').style.display = 'none';
  });

  // ── Profile select ────────────────
  document.getElementById('profile-select')?.addEventListener('change', async (e) => {
    activeProfileId = e.target.value;
    await setConfig('activeProfile', activeProfileId);
    updatePromptPreview();
  });

  // ── Add profile ───────────────────
  document.getElementById('btn-add-profile')?.addEventListener('click', async () => {
    const name = prompt('New profile name:');
    if (!name || !name.trim()) return;
    const promptText = prompt(`Enter the prompt for "${name.trim()}":\n(Use [N] for file count)`);
    if (promptText === null) return;

    const newProfile = {
      id:     'profile-' + Date.now(),
      name:   name.trim(),
      prompt: promptText.trim() || DEFAULT_PROMPT,
    };
    profiles.push(newProfile);
    activeProfileId = newProfile.id;
    await setConfig('profiles', profiles);
    await setConfig('activeProfile', activeProfileId);
    renderProfiles();
  });

  // ── Edit profile ──────────────────
  document.getElementById('btn-edit-profile')?.addEventListener('click', () => {
    const body  = document.getElementById('prompt-body');
    const arrow = document.getElementById('accordion-arrow');
    if (body && body.style.display === 'none') {
      body.style.display = 'block';
      arrow?.classList.add('open');
    }
    document.getElementById('prompt-preview')?.focus();
  });

  document.getElementById('row-inc')?.addEventListener('click', () => {
    const el = document.getElementById('excel-rows-per-prompt');
    if (el) { el.value = Number(el.value) + 1; saveExcelSettings(); }
  });
  document.getElementById('row-dec')?.addEventListener('click', () => {
    const el = document.getElementById('excel-rows-per-prompt');
    if (el && Number(el.value) > 1) { el.value = Number(el.value) - 1; saveExcelSettings(); }
  });
  document.getElementById('excel-rows-per-prompt')?.addEventListener('change', saveExcelSettings);
  document.getElementById('excel-include-headers')?.addEventListener('change', saveExcelSettings);

  // PDF settings listeners
  document.getElementById('pdf-inc')?.addEventListener('click', () => {
    const el = document.getElementById('pdf-files-per-prompt');
    if (el) { el.value = Number(el.value) + 1; savePdfSettings(); }
  });
  document.getElementById('pdf-dec')?.addEventListener('click', () => {
    const el = document.getElementById('pdf-files-per-prompt');
    if (el && Number(el.value) > 1) { el.value = Number(el.value) - 1; savePdfSettings(); }
  });
  document.getElementById('pdf-files-per-prompt')?.addEventListener('change', savePdfSettings);

  // Load PDF settings on start
  loadPdfSettings();

  // ── Delete profile ────────────────
  document.getElementById('btn-delete-profile')?.addEventListener('click', async () => {
    if (profiles.length <= 1) { alert('You must have at least one profile.'); return; }
    if (!confirm(`Delete profile "${profiles.find(p => p.id === activeProfileId)?.name}"?`)) return;
    profiles = profiles.filter(p => p.id !== activeProfileId);
    activeProfileId = profiles[0].id;
    await setConfig('profiles', profiles);
    await setConfig('activeProfile', activeProfileId);
    renderProfiles();
  });

  // ── Save prompt ───────────────────
  document.getElementById('btn-save-prompt')?.addEventListener('click', async () => {
    const textarea = document.getElementById('prompt-preview');
    if (!textarea) return;
    const profile = profiles.find(p => p.id === activeProfileId);
    if (!profile) return;
    profile.prompt = textarea.value;
    await setConfig('profiles', profiles);
    const btn = document.getElementById('btn-save-prompt');
    const orig = btn.textContent;
    btn.textContent = '✓ Saved';
    btn.style.color = 'var(--success)';
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1500);
  });

  // ── Accordion toggle ──────────────
  document.getElementById('prompt-toggle')?.addEventListener('click', () => {
    const body   = document.getElementById('prompt-body');
    const arrow  = document.getElementById('accordion-arrow');
    const toggle = document.getElementById('prompt-toggle');
    if (!body) return;
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    arrow?.classList.toggle('open', !isOpen);
    toggle?.setAttribute('aria-expanded', String(!isOpen));
  });

  document.getElementById('prompt-toggle')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click();
  });

  // ── Rows per prompt ───────────────
  document.getElementById('row-dec')?.addEventListener('click', () => {
    const input = document.getElementById('excel-rows-per-prompt');
    input.value = Math.max(1, (Number(input.value) || 50) - 10);
    saveExcelSettings();
  });

  document.getElementById('row-inc')?.addEventListener('click', () => {
    const input = document.getElementById('excel-rows-per-prompt');
    input.value = Math.min(500, (Number(input.value) || 50) + 10);
    saveExcelSettings();
  });

  document.getElementById('excel-rows-per-prompt')?.addEventListener('change', saveExcelSettings);
  document.getElementById('excel-include-headers')?.addEventListener('change', saveExcelSettings);

  // ── Clear all files ───────────────
  document.getElementById('btn-clear-files')?.addEventListener('click', async () => {
    if (!confirm('Remove ALL pending spreadsheet files? This cannot be undone.')) return;
    await clearInputFiles();
    await renderFileList();
    if (currentJobState === 'RUNNING') safeSendMessage({ action: 'PAUSE_JOB' });
  });

  // ── Reset All ─────────────────────
  document.getElementById('btn-reset-all')?.addEventListener('click', async () => {
    if (!confirm('⚠️ Are you sure you want to RESET EVERYTHING?\n\nThis will delete all pending files, clear the extracted output buffer, and reset the job state. Prompt profiles will be kept.')) return;
    await clearInputFiles();
    await clearOutputBuffer();
    safeSendMessage({ action: 'CLEAR_DATA' });
    await renderFileList();
    updateButtonStates('IDLE');
    const statusText = document.getElementById('status-text');
    if (statusText) statusText.textContent = 'Ready';
    await refreshOutputInfo();
  });

  // ── Run button ────────────────────
  document.getElementById('btn-run')?.addEventListener('click', async () => {
    const inputMode     = document.querySelector('input[name="input-mode"]:checked')?.value || 'spreadsheet';
    const addSysPrompt  = document.getElementById('chk-system-prompt')?.checked ?? false;
    const activeProfile = profiles.find(p => p.id === activeProfileId);
    const systemPrompt  = activeProfile?.prompt || '';

    if (!activeProfileId) {
      alert('Please select a prompt profile.');
      return;
    }

    // ── BUILD PROMPT HELPER ──────────────────────────────────────────
    const buildFinalPrompt = (inputData) => {
      const dataStr = inputData ? inputData.trim() : '';
      if (addSysPrompt && systemPrompt.trim()) {
        if (!dataStr) return systemPrompt.trim(); // No input data, just prompt
        return `${systemPrompt.trim()}\n\nINPUT DATA:\n${dataStr}`;
      }
      if (!dataStr) return null; // Signal: no input and no sys prompt
      return dataStr;
    };

    // ── RAW INPUT MODE ───────────────────────────────────────────────
    if (inputMode === 'raw') {
      const rawText = document.getElementById('raw-input-text')?.value?.trim() || '';

      const finalPrompt = buildFinalPrompt(rawText);
      if (!finalPrompt) {
        alert('⚠️ No Input Data\n\nPlease enter some text in the Raw Input field, or enable "Add System Prompt".');
        return;
      }

      // Create a synthetic single-chunk file record in IndexedDB
      const fakeFile = {
        id: 'raw-' + Date.now(),
        name: 'raw_input.txt',
        size: new Blob([finalPrompt]).size,
        type: 'text/plain',
        status: 'pending',
        fileData: null,
        excelChunks: [{ text: finalPrompt, rowRange: 'All' }],
      };

      // Store it to DB using addFile-compatible format
      await setConfig('rawJobFile', fakeFile);

      safeSendMessage({
        action:          'START_RAW_JOB',
        file:            fakeFile,
        profileId:       activeProfileId,
        batchDelay:      Number(document.getElementById('batch-delay-seconds')?.value) || 0,
        newChatPerBatch: document.getElementById('new-chat-per-batch')?.checked ?? false,
      });

      updateButtonStates('RUNNING');
      return;
    }

    // ── FILE INPUT MODE ──────────────────────────────────────────────
    const files = await getAllFiles().catch(() => []);

    const pendingFiles = files.filter(f => f.status === 'pending');

    if (pendingFiles.length === 0) {
      const finalPrompt = buildFinalPrompt('');
      if (finalPrompt) {
        // Run as a single prompt job even if file mode was selected
        const fakeFile = {
          id: 'sysprompt-' + Date.now(),
          name: 'system_prompt_only.txt',
          size: new Blob([finalPrompt]).size,
          type: 'text/plain',
          status: 'pending',
          fileData: null,
          excelChunks: [{ text: finalPrompt, rowRange: 'All' }],
        };

        await setConfig('rawJobFile', fakeFile);

        safeSendMessage({
          action:          'START_RAW_JOB',
          file:            fakeFile,
          profileId:       activeProfileId,
          batchDelay:      Number(document.getElementById('batch-delay-seconds')?.value) || 0,
          newChatPerBatch: document.getElementById('new-chat-per-batch')?.checked ?? false,
        });

        updateButtonStates('RUNNING');
        return;
      } else {
        alert('⚠️ No Input Data\n\nPlease add files first, or enable "Add System Prompt".');
        return;
      }
    }

    const hasSpreadsheet = pendingFiles.some(f => {
      const n = f.name.toLowerCase();
      return n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.csv');
    });

    // BRANCH: PDF vs SPREADSHEET
    if (inputMode === 'pdf') {
      // PDF Processing Mode
      const filesPerPrompt = Number(document.getElementById('pdf-files-per-prompt')?.value) || 1;
      document.getElementById('status-text').textContent = 'Preparing PDF files...';

      safeSendMessage({
        action:          'START_PDF_JOB',
        filesPerPrompt:  filesPerPrompt,
        profileId:       activeProfileId,
        prompt:          buildFinalPrompt(''),
        batchDelay:      Number(document.getElementById('batch-delay-seconds')?.value) || 0,
        newChatPerBatch: document.getElementById('new-chat-per-batch')?.checked ?? false,
      });

      updateButtonStates('RUNNING');
      return;
    }

    // Spreadsheet Processing Mode
    const rowsPerPrompt  = Number(document.getElementById('excel-rows-per-prompt')?.value) || 50;
    const sheetName      = document.getElementById('excel-sheet-select')?.value;
    const checkboxes     = document.querySelectorAll('#excel-column-selector input[type="checkbox"]:checked');
    const selectedColumns = Array.from(checkboxes).map(cb => Number(cb.value));

    if (!sheetName) {
      alert('Please select a sheet to process.');
      return;
    }
    if (selectedColumns.length === 0) {
      alert('Please select at least one column to process.');
      return;
    }

    const includeHeaders = document.getElementById('excel-include-headers')?.checked ?? true;

    // Pre-process all pending files into markdown chunk strings
    document.getElementById('status-text').textContent = 'Formatting spreadsheet data...';

    for (const file of pendingFiles) {
      try {
        const workbook  = XLSX.read(file.fileData, { type: 'array' });
        const worksheet = workbook.Sheets[sheetName];
        if (!worksheet) continue;

        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
        if (rows.length <= 1) continue; // Only header or empty

        const headers      = rows[0];
        const dataRows     = rows.slice(1);
        const chunks       = [];

        const selectedHeaders = selectedColumns.map(idx => headers[idx] || `Col ${idx}`);
        const headerRowMd     = '| ' + selectedHeaders.join(' | ') + ' |';
        const sepRowMd        = '| ' + selectedHeaders.map(() => '---').join(' | ') + ' |';

        for (let i = 0; i < dataRows.length; i += rowsPerPrompt) {
          const chunkRows = dataRows.slice(i, i + rowsPerPrompt);
          let md = '';
          if (includeHeaders) md += headerRowMd + '\n' + sepRowMd + '\n';
          for (const row of chunkRows) {
            const rowData = selectedColumns.map(idx => {
              const val = row[idx];
              return (val !== undefined && val !== null)
                ? String(val).replace(/\|/g, '\\|').replace(/\n/g, ' ')
                : '';
            });
            md += '| ' + rowData.join(' | ') + ' |\n';
          }

          // Apply system prompt wrapper if enabled
          const inputData = md.trim();
          const finalChunk = buildFinalPrompt(inputData) || inputData;
          chunks.push({
            text: finalChunk,
            rowRange: `${i + 1}-${Math.min(i + rowsPerPrompt, dataRows.length)}`
          });
        }

        file.excelChunks = chunks;
        await updateFile(file);
      } catch (e) {
        console.error(`[Popup] Failed to format ${file.name}:`, e);
      }
    }

    // Kick off the job
    safeSendMessage({
      action:          'START_EXCEL_JOB',
      profileId:       activeProfileId,
      batchDelay:      Number(document.getElementById('batch-delay-seconds')?.value) || 0,
      newChatPerBatch: document.getElementById('new-chat-per-batch')?.checked ?? false,
    });

    updateButtonStates('RUNNING');
  });

  // ── Pause ─────────────────────────
  document.getElementById('btn-pause')?.addEventListener('click', () => {
    safeSendMessage({ action: 'PAUSE_JOB' });
    updateButtonStates('PAUSED');
  });

  // ── Resume ────────────────────────
  document.getElementById('btn-resume')?.addEventListener('click', () => {
    safeSendMessage({ action: 'RESUME_JOB' });
    updateButtonStates('RUNNING');
  });

  // ── Stop ──────────────────────────
  document.getElementById('btn-stop')?.addEventListener('click', () => {
    if (!confirm('Are you sure you want to completely stop the automation?')) return;
    safeSendMessage({ action: 'STOP_JOB' });
    updateButtonStates('IDLE');
  });

  // ── Download output ───────────────
  document.getElementById('btn-download-txt')?.addEventListener('click',  () => handleDownload('txt'));
  document.getElementById('btn-download-csv')?.addEventListener('click',  () => handleDownload('csv'));
  document.getElementById('btn-download-xlsx')?.addEventListener('click', () => handleDownload('xlsx'));

  // ── View output ───────────────────
  document.getElementById('btn-view-output')?.addEventListener('click', () => {
    chrome.windows.create({
      url:     chrome.runtime.getURL('popup/viewer.html'),
      type:    'popup',
      width:   880,
      height:  640,
      focused: true,
    });
  });

  // ── SidePanel toggle ──────────────
  document.getElementById('btn-sidepanel')?.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.sidePanel.setOptions({ enabled: true, path: 'popup/index.html' });
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    } catch (err) {
      console.warn('[Popup] SidePanel open error:', err.message);
    }
  });
}

// ─────────────────────────────────────────────
// Dropzone Setup
// ─────────────────────────────────────────────

function setupDropzone() {
  const dropzone  = document.getElementById('dropzone-files');
  const fileInput = document.getElementById('file-input');
  if (!dropzone || !fileInput) return;

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });

  fileInput.addEventListener('change', async (e) => {
    if (e.target.files?.length) {
      await processFiles(e.target.files);
      fileInput.value = '';
    }
  });

  // Drag events
  dropzone.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragover',  (e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove('drag-over'); });
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) await processFiles(e.dataTransfer.files);
  });

  // ── Folder Dropzone ────────────────
  const folderDropzone = document.getElementById('dropzone-folder');
  const folderInput    = document.getElementById('folder-input');
  if (folderDropzone && folderInput) {
    folderDropzone.addEventListener('click', () => folderInput.click());
    folderDropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') folderInput.click();
    });
    folderInput.addEventListener('change', async (e) => {
      if (e.target.files?.length) {
        await processFiles(e.target.files);
        folderInput.value = '';
      }
    });
  }
}

// ─────────────────────────────────────────────
// Download / Output
// ─────────────────────────────────────────────

/**
 * Parses markdown table output into rows (with filename prefix column).
 * @param {string} text
 * @returns {string[][]}
 */
function parseMarkdownTable(text) {
  const rows = [];
  const lines = text.split('\n');
  let currentFile = 'Unknown File';

  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('# ')) {
      currentFile = line.substring(2).trim();
    } else if (line.startsWith('FILE: ')) {
      currentFile = line.substring(6).trim();
    } else if (line.startsWith('|')) {
      if (line.includes('---')) continue; // skip separator
      const cols = line.split('|').slice(1, -1).map(c => c.trim());
      if (cols.length > 0 && cols[0].toLowerCase() === 'col1') {
        rows.push(['Source File', ...cols]);
      } else {
        rows.push([currentFile, ...cols]);
      }
    }
  }
  return rows;
}

/**
 * Handles a download request for the output buffer.
 * @param {'txt'|'csv'|'xlsx'} format
 */
async function handleDownload(format) {
  try {
    const text = await getOutputBuffer();
    if (!text || text.trim() === '') {
      alert('No extracted data yet. Run the automation first.');
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let blob;
    let filename = `ai_studio_output_${timestamp}.${format}`;

    if (format === 'txt') {
      blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    } else if (format === 'csv' || format === 'xlsx') {
      if (typeof XLSX === 'undefined') {
        alert('SheetJS library is not loaded.');
        return;
      }
      const data = parseMarkdownTable(text);
      if (data.length === 0) {
        alert('No tabular data found in the output.');
        return;
      }
      const ws = XLSX.utils.aoa_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'AI Studio Output');

      if (format === 'csv') {
        blob = new Blob([XLSX.utils.sheet_to_csv(ws)], { type: 'text/csv;charset=utf-8' });
      } else {
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        blob = new Blob([wbout], { type: 'application/octet-stream' });
      }
    }

    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 15_000);

    const shouldClear = confirm('Download started! Clear the extracted data from extension memory?');
    if (shouldClear) {
      await clearOutputBuffer();
      await refreshOutputInfo();
    }
  } catch (err) {
    console.error('[Popup] Download error:', err);
    alert('Download failed: ' + err.message);
  }
}

// ─────────────────────────────────────────────
// Message Listener (from Background)
// ─────────────────────────────────────────────

function setupMessageListener() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'JOB_STATUS') {
      handleStatusUpdate(msg).catch(console.error);
    }
  });
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

/**
 * Sends a message to the background service worker, silently ignoring errors.
 * @param {object} msg
 */
function safeSendMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[Popup] sendMessage error:', chrome.runtime.lastError.message);
      }
    });
  } catch (err) {
    console.error('[Popup] sendMessage threw:', err.message);
  }
}

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
