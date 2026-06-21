// background.js — AI Studio Automator (AI Studio Only)
// Manages state machine, Excel batch injection, watchdog, retry logic, and messaging.

import {
  openDB,
  getPendingFiles,
  updateFileStatus,
  getConfig,
  setConfig,
  appendOutputBuffer,
  getFileById,
} from './lib/idb.js';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Watchdog timeout in milliseconds (35 minutes). AI Studio can take a long time. */
const WATCHDOG_MS = 35 * 60 * 1000;

/** Maximum number of automatic retries before a batch is marked failed. */
const MAX_RETRIES = 2;

/** Milliseconds to wait after a tab becomes active before injecting. */
const SETTLE_MS = 2_500;

// ─────────────────────────────────────────────
// Mutable job state
// ─────────────────────────────────────────────

/**
 * Central mutable state for the running job.
 */
const rawState = {
  status: 'IDLE',
  activeBatch: null,
  processed: 0,
  failed: 0,
  total: 0,
  startTime: null,
  batchTimes: [],
  retryCount: 0,
  watchdogTimer: null,
  activeTabId: null,
  jobMode: 'excel',
  excelState: null,
  generationStarted: false,
  batchDelay: 0,           // user-defined delay (seconds) between batches
};

let _saveTimeout = null;
const state = new Proxy(rawState, {
  set(target, prop, value) {
    target[prop] = value;
    if (prop !== 'watchdogTimer') {
      if (_saveTimeout) clearTimeout(_saveTimeout);
      _saveTimeout = setTimeout(() => {
        const { watchdogTimer, ...savable } = target;
        chrome.storage.session.set({ jobState: savable }).catch(() => {});
      }, 50);
    }
    return true;
  }
});

const initPromise = chrome.storage.session.get('jobState').then((data) => {
  if (data.jobState) {
    Object.assign(rawState, data.jobState);
    if (rawState.status === 'RUNNING' && rawState.activeBatch) {
      startWatchdog();
    }
  }
}).catch(() => {});

// ─────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────

/**
 * Returns a Promise that resolves after `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns a human-readable label for the current job status.
 * @returns {string}
 */
function getStatusText() {
  switch (state.status) {
    case 'IDLE':    return 'Idle';
    case 'RUNNING': return 'Running...';
    case 'PAUSED':  return 'Paused';
    case 'ERROR':   return 'Error — Check AI Studio tab';
    default:        return state.status;
  }
}

// ─────────────────────────────────────────────
// Watchdog
// ─────────────────────────────────────────────

/**
 * Cancels any active watchdog timer.
 */
function clearWatchdog() {
  if (state.watchdogTimer !== null) {
    clearTimeout(state.watchdogTimer);
    state.watchdogTimer = null;
  }
}

/**
 * Starts (or restarts) the 20-minute watchdog timer.
 * On expiry retries the current batch or marks it failed.
 */
function startWatchdog() {
  clearWatchdog();
  state.watchdogTimer = setTimeout(async () => {
    if (state.status !== 'RUNNING') return;
    console.warn('[Watchdog] Fired — AI Studio may be frozen. retryCount=', state.retryCount);

    if (state.retryCount < MAX_RETRIES) {
      state.retryCount++;

      if (state.activeTabId !== null) {
        chrome.tabs.sendMessage(state.activeTabId, {
          action: 'UPDATE_WIDGET_STATE',
          status: `Timeout — Retry ${state.retryCount}/${MAX_RETRIES}...`,
          total: state.total,
          processed: state.processed,
          remaining: Math.max(0, state.total - state.processed - state.failed),
          failed: state.failed,
        }).catch(() => {});

        try {
          await chrome.tabs.reload(state.activeTabId);
        } catch (e) {
          console.warn('[Watchdog] Tab reload failed:', e.message);
        }
        await waitForTabLoad(state.activeTabId);
        await sleep(SETTLE_MS);
      }

      retryCurrentBatch();
    } else {
      console.error('[Watchdog] Max retries exceeded for batch', state.activeBatch?.batchIndex);
      if (state.activeBatch) {
        for (const id of state.activeBatch.fileIds) {
          await updateFileStatus(id, 'failed');
        }
        state.failed += state.activeBatch.fileIds.length;
      }
      state.retryCount = 0;
      state.activeBatch = null;
      broadcastStatus();
      runNextExcelBatch();
    }
  }, WATCHDOG_MS);
}

// ─────────────────────────────────────────────
// Tab management
// ─────────────────────────────────────────────

/**
 * Locates an existing AI Studio tab and activates it.
 * Returns null if no AI Studio tab is open — user must open one manually.
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function getOrCreateChatTab() {
  const existingTabs = await chrome.tabs.query({ url: '*://aistudio.google.com/*' });
  if (existingTabs.length > 0) {
    const tab = existingTabs[0];
    state.activeTabId = tab.id;
    await chrome.tabs.update(tab.id, { active: true });
    return tab;
  }
  console.warn('[AI Studio] No existing tab found. Please open aistudio.google.com before running.');
  return null;
}

/**
 * Returns a Promise that resolves when the given tab reaches 'complete' status,
 * or after a 30-second safety timeout.
 * @param {number} tabId
 * @returns {Promise<void>}
 */
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30_000);

    /**
     * @param {number} updatedTabId
     * @param {chrome.tabs.TabChangeInfo} changeInfo
     */
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ─────────────────────────────────────────────
// Broadcast / widget helpers
// ─────────────────────────────────────────────

/**
 * Pushes current job statistics to the overlay widget on the active AI Studio tab.
 */
async function updateWidget() {
  if (state.activeTabId === null) return;

  const excelSettings = await getConfig('excelSettings');
  const rowsPerPrompt = excelSettings ? excelSettings.rowsPerPrompt : 50;

  // For PDF mode send real per-file counts; for Excel send batch counts
  const isP = state.jobMode === 'pdf';
  const wTotal     = isP ? (state.totalFileCount     ?? state.total) : state.total;
  const wProcessed = isP ? (state.processedFileCount ?? state.processed) : state.processed;
  const wRemaining = Math.max(0, wTotal - wProcessed - state.failed);

  chrome.tabs.sendMessage(state.activeTabId, {
    action: 'UPDATE_WIDGET_STATE',
    jobMode: state.rawFile ? 'raw' : (state.jobMode || 'excel'),
    rowsPerPrompt,
    total:     wTotal,
    processed: wProcessed,
    remaining: wRemaining,
    failed: state.failed,
    status: getStatusText(),
    runTime: state.startTime !== null ? Date.now() - state.startTime : 0,
    avgTime:
      state.batchTimes.length > 0
        ? state.batchTimes.reduce((a, b) => a + b, 0) / state.batchTimes.length
        : 0,
    batchIndex: state.activeBatch?.batchIndex ?? 0,
    totalBatches: wTotal,
  }).catch(() => {});
}

/**
 * Broadcasts the current job status to the popup/side-panel and updates the overlay widget.
 */
function broadcastStatus() {
  const avgTime =
    state.batchTimes.length > 0
      ? state.batchTimes.reduce((a, b) => a + b, 0) / state.batchTimes.length
      : 0;

  chrome.runtime.sendMessage({
    action: 'JOB_STATUS',
    state: state.status,
    processed: state.processed,
    total: state.total,
    failed: state.failed,
    runTime: state.startTime !== null ? Date.now() - state.startTime : 0,
    avgTime,
  }).catch(() => {});

  updateWidget();
}

/**
 * Sends a sound-play instruction to the content script.
 * @param {'success'|'error'} type
 */
async function sendSoundToContent(type) {
  if (state.activeTabId === null) return;
  try {
    await chrome.tabs.sendMessage(state.activeTabId, { action: 'PLAY_SOUND', type });
  } catch (e) {
    console.warn('[Sound] Could not deliver PLAY_SOUND message:', e.message);
  }
}

// ─────────────────────────────────────────────
// Core Excel batch pipeline
// ─────────────────────────────────────────────

/**
 * Re-injects the current active chunk after a watchdog timeout retry.
 * @returns {Promise<void>}
 */
async function retryCurrentBatch() {
  if (!state.activeBatch || state.status !== 'RUNNING') return;

  startWatchdog();
  state.generationStarted = false;

  if (state.jobMode === 'pdf') {
    const filesData = [];
    for (const id of state.activeBatch.fileIds) {
      const f = await getFileById(id);
      if (f) {
        filesData.push({
          id: f.id,
          name: f.name,
          type: f.type,
          size: f.size,
          base64Data: arrayBufferToBase64(f.fileData)
        });
      }
    }
    
    if (state.activeTabId !== null) {
      chrome.tabs.sendMessage(state.activeTabId, {
        action: 'INJECT_PDF_PROMPT',
        files: filesData,
        prompt: state.pdfPrompt,
        batchIndex: state.processed,
        totalBatches: state.total,
        newChatPerBatch: state.newChatPerBatch,
      }).catch(() => {});
    }
  } else if (state.rawFile) {
    const chunkData = state.rawFile.excelChunks[state.processed];
    if (state.activeTabId !== null) {
      chrome.tabs.sendMessage(state.activeTabId, {
        action: 'INJECT_EXCEL_PROMPT',
        prompt: typeof chunkData === 'string' ? chunkData : chunkData.text,
        rowRange: typeof chunkData === 'string' ? 'All' : chunkData.rowRange,
        batchIndex: state.processed,
        totalBatches: state.total,
        fileName: state.rawFile.name,
        newChatPerBatch: state.newChatPerBatch,
      }).catch(() => {});
    }
  } else {
    const fileId = state.excelState.fileId;
    const chunkIndex = state.excelState.chunkIndex;
    const file = await getFileById(fileId);
    if (!file || !file.excelChunks || chunkIndex >= file.excelChunks.length) return;

    const chunkData = file.excelChunks[chunkIndex];

    if (state.activeTabId !== null) {
      chrome.tabs.sendMessage(
        state.activeTabId,
        {
          action: 'INJECT_EXCEL_PROMPT',
          prompt: typeof chunkData === 'string' ? chunkData : chunkData.text,
          rowRange: typeof chunkData === 'string' ? 'Unknown' : chunkData.rowRange,
          batchIndex: state.processed,
          totalBatches: state.total,
          fileName: file.name,
          newChatPerBatch: state.newChatPerBatch,
        },
        (_response) => {
          if (chrome.runtime.lastError) {
            console.warn('[Retry] sendMessage failed:', chrome.runtime.lastError.message);
          }
        }
      );
    }
  }
  updateWidget();
}

/**
 * Drives a raw text job (single or multiple synthetic chunks).
 * Reuses the same injection/extraction pipeline as Excel mode.
 */
async function runNextRawBatch() {
  if (state.status !== 'RUNNING') return;
  if (!state.rawFile) { state.status = 'IDLE'; broadcastStatus(); return; }

  const file    = state.rawFile;
  const chunkIdx = state.processed; // use processed count as chunk cursor

  if (chunkIdx >= file.excelChunks.length) {
    // All raw chunks done
    state.status  = 'IDLE';
    state.rawFile = null;
    broadcastStatus();
    await sendSoundToContent('success');
    return;
  }

  const chunkData = file.excelChunks[chunkIdx];

  state.activeBatch = {
    fileIds:   [file.id],
    fileNames: [file.name],
    batchIndex: state.processed,
    startTime: Date.now(),
  };
  state.generationStarted = false;

  state.excelState = {
    fileId: file.id,
    chunkIndex: chunkIdx,
    totalChunks: file.excelChunks.length,
  };

  const tab = await getOrCreateChatTab();
  if (!tab) {
    console.error('[runNextRawBatch] No AI Studio tab found.');
    state.status = 'ERROR';
    broadcastStatus();
    return;
  }
  state.activeTabId = tab.id;

  await sleep(SETTLE_MS);
  startWatchdog();

  chrome.tabs.sendMessage(
    tab.id,
    {
      action:       'INJECT_EXCEL_PROMPT',
      prompt:       typeof chunkData === 'string' ? chunkData : chunkData.text,
      rowRange:     typeof chunkData === 'string' ? 'All' : chunkData.rowRange,
      batchIndex:   state.processed,
      totalBatches: state.total,
      fileName:     file.name,
      newChatPerBatch: state.newChatPerBatch,
    },
    (_response) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || '';
        console.warn('[runNextRawBatch] sendMessage error:', errMsg);
        clearWatchdog();
        if (errMsg.includes('Receiving end does not exist')) {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js'],
          }).then(() => {
            setTimeout(() => retryCurrentBatch(), 1500);
          }).catch(() => setTimeout(() => retryCurrentBatch(), 5000));
        } else {
          setTimeout(retryCurrentBatch, 5000);
        }
      }
    }
  );

  updateWidget();
}

/**
 * Converts an ArrayBuffer to a Base64 string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Batches and sends the next set of PDF files to AI Studio.
 * @returns {Promise<void>}
 */
async function runNextPdfBatch() {
  if (state.status !== 'RUNNING') return;

  const pendingFiles = await getPendingFiles();
  
  if (pendingFiles.length === 0) {
    // All files processed — job complete
    state.status = 'IDLE';
    broadcastStatus();
    await sendSoundToContent('success');
    return;
  }

  // Grab the next batch of files
  const filesPerPrompt = state.filesPerPrompt || 1;
  const batchFiles = pendingFiles.slice(0, filesPerPrompt);
  
  const filesData = [];
  for (const f of batchFiles) {
    await updateFileStatus(f.id, 'sent');
    filesData.push({
      id: f.id,
      name: f.name,
      type: f.type,
      size: f.size,
      base64Data: arrayBufferToBase64(f.fileData)
    });
  }

  state.activeBatch = {
    fileIds: batchFiles.map(f => f.id),
    fileNames: batchFiles.map(f => f.name),
    batchIndex: state.processed,
    startTime: Date.now(),
  };
  state.generationStarted = false;
  
  if (state.pdfState) {
    state.pdfState.batchIndex = state.processed;
  }

  // Ensure an AI Studio tab is open
  const tab = await getOrCreateChatTab();
  if (!tab) {
    console.error('[runNextPdfBatch] No AI Studio tab found. Please open aistudio.google.com.');
    state.status = 'ERROR';
    broadcastStatus();
    return;
  }
  state.activeTabId = tab.id;

  await sleep(SETTLE_MS);
  startWatchdog();

  chrome.tabs.sendMessage(
    tab.id,
    {
      action: 'INJECT_PDF_PROMPT',
      files: filesData,
      prompt: state.pdfPrompt,
      batchIndex: state.processed,
      totalBatches: state.total,
      newChatPerBatch: state.newChatPerBatch,
    },
    (_response) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || '';
        console.warn('[runNextPdfBatch] sendMessage error:', errMsg);
        clearWatchdog();
        if (errMsg.includes('Receiving end does not exist')) {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js'],
          }).then(() => {
            setTimeout(() => retryCurrentBatch(), 1500);
          }).catch(() => setTimeout(() => retryCurrentBatch(), 5000));
        } else {
          setTimeout(retryCurrentBatch, 5000);
        }
      }
    }
  );

  updateWidget();
}

/**
 * Sends the next Excel data chunk to AI Studio and waits for the result.
 * When all chunks of a file are processed, moves to the next file.
 * @returns {Promise<void>}
 */
async function runNextExcelBatch() {
  if (state.status !== 'RUNNING') return;

  let nextFile = null;

  // If we are already processing an Excel file, fetch it directly
  if (state.excelState && state.excelState.fileId) {
    const activeFile = await getFileById(state.excelState.fileId);
    if (activeFile && state.excelState.chunkIndex < activeFile.excelChunks.length) {
      nextFile = activeFile;
    } else if (activeFile) {
      // Finished all chunks for this file
      await updateFileStatus(activeFile.id, 'processed');
      state.excelState = null;
    }
  }

  // If no active file, find the next pending Excel file
  if (!nextFile) {
    const pendingFiles = await getPendingFiles();
    for (const f of pendingFiles) {
      if (f.excelChunks && f.excelChunks.length > 0) {
        nextFile = f;
        break;
      } else if (f.excelChunks && f.excelChunks.length === 0) {
        await updateFileStatus(f.id, 'processed');
      }
    }
  }

  if (!nextFile) {
    // All files processed — job complete
    state.status = 'IDLE';
    broadcastStatus();
    await sendSoundToContent('success');
    return;
  }

  let currentChunkIndex = 0;
  if (state.excelState && state.excelState.fileId === nextFile.id) {
    currentChunkIndex = state.excelState.chunkIndex;
  }

  if (currentChunkIndex === 0) {
    await updateFileStatus(nextFile.id, 'sent');
  }

  const chunkData = nextFile.excelChunks[currentChunkIndex];

  state.activeBatch = {
    fileIds: [nextFile.id],
    fileNames: [nextFile.name],
    batchIndex: state.processed,
    startTime: Date.now(),
  };
  state.generationStarted = false;

  state.excelState = {
    fileId: nextFile.id,
    chunkIndex: currentChunkIndex,
    totalChunks: nextFile.excelChunks.length,
  };

  // Ensure an AI Studio tab is open
  const tab = await getOrCreateChatTab();
  if (!tab) {
    console.error('[runNextExcelBatch] No AI Studio tab found. Please open aistudio.google.com.');
    state.status = 'ERROR';
    broadcastStatus();
    return;
  }
  state.activeTabId = tab.id;

  await sleep(SETTLE_MS);
  startWatchdog();

  chrome.tabs.sendMessage(
    tab.id,
    {
      action: 'INJECT_EXCEL_PROMPT',
      prompt: typeof chunkData === 'string' ? chunkData : chunkData.text,
      rowRange: typeof chunkData === 'string' ? 'Unknown' : chunkData.rowRange,
      batchIndex: state.processed,
      totalBatches: state.total,
      fileName: nextFile.name,
      newChatPerBatch: state.newChatPerBatch,
    },
    (_response) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || '';
        console.warn('[runNextExcelBatch] sendMessage error:', errMsg);
        clearWatchdog();
        if (errMsg.includes('Receiving end does not exist')) {
          // Content script not injected yet — inject it then retry
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js'],
          }).then(() => {
            setTimeout(() => retryCurrentBatch(), 1500);
          }).catch((injectErr) => {
            console.warn('[runNextExcelBatch] Could not inject content script:', injectErr.message);
            setTimeout(() => retryCurrentBatch(), 5000);
          });
        } else {
          setTimeout(retryCurrentBatch, 5000);
        }
      }
    }
  );

  updateWidget();
}

// ── Live Widget Ticker ─────────────────────────────────────
setInterval(() => {
  if (state.status === 'RUNNING' || state.status === 'PAUSED') {
    updateWidget();
  }
}, 1000);

// ─────────────────────────────────────────────
// Message handler
// ─────────────────────────────────────────────

/**
 * Central message router. Always returns true for async response support.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;

  (async () => {
    await initPromise;

    switch (msg.action) {

      // ── START_EXCEL_JOB ──────────────────────────────────────────────────
      case 'START_EXCEL_JOB': {
        if (state.status !== 'IDLE') {
          sendResponse({ ok: false, reason: 'Job already running or paused' });
          return;
        }

        if (msg.profileId !== undefined) {
          await setConfig('activeProfile', msg.profileId);
        }

        state.jobMode     = 'excel';
        state.excelState  = null;
        state.status      = 'RUNNING';
        state.processed   = 0;
        state.failed      = 0;
        state.retryCount  = 0;
        state.startTime   = Date.now();
        state.batchTimes  = [];
        state.activeBatch = null;
        state.generationStarted = false;
        state.newChatPerBatch = msg.newChatPerBatch || false;
        state.batchDelay      = Math.max(0, Number(msg.batchDelay) || 0);

        // Count total chunks across all pending files
        const pending = await getPendingFiles();
        let totalChunks = 0;
        for (const f of pending) {
          if (f.excelChunks) totalChunks += f.excelChunks.length;
        }
        state.total = totalChunks;

        broadcastStatus();
        runNextExcelBatch(); // intentionally not awaited

        sendResponse({ ok: true });
        break;
      }

      // ── START_PDF_JOB ────────────────────────────────────────────────────
      case 'START_PDF_JOB': {
        if (state.status !== 'IDLE') {
          sendResponse({ ok: false, reason: 'Job already running or paused' });
          return;
        }

        if (msg.profileId !== undefined) {
          await setConfig('activeProfile', msg.profileId);
        }

        state.jobMode     = 'pdf';
        state.excelState  = null;
        state.pdfState    = { batchIndex: 0 };
        state.pdfPrompt   = msg.prompt || null;
        state.filesPerPrompt = msg.filesPerPrompt || 1;
        state.status      = 'RUNNING';
        state.processed   = 0;
        state.failed      = 0;
        state.retryCount  = 0;
        state.startTime   = Date.now();
        state.batchTimes  = [];
        state.activeBatch = null;
        state.generationStarted = false;
        state.newChatPerBatch = msg.newChatPerBatch || false;
        state.batchDelay      = Math.max(0, Number(msg.batchDelay) || 0);

        const pending = await getPendingFiles();
        state.totalFileCount   = pending.length;                                   // actual file count
        state.processedFileCount = 0;
        state.total = Math.ceil(pending.length / state.filesPerPrompt);            // batch count (internal)

        broadcastStatus();
        runNextPdfBatch(); // intentionally not awaited

        sendResponse({ ok: true });
        break;
      }

      // ── START_RAW_JOB ────────────────────────────────────────────────────
      // Raw text mode: a single synthetic chunk is passed directly from popup.
      case 'START_RAW_JOB': {
        if (state.status !== 'IDLE') {
          sendResponse({ ok: false, reason: 'Job already running or paused' });
          return;
        }

        if (msg.profileId !== undefined) {
          await setConfig('activeProfile', msg.profileId);
        }

        state.jobMode     = 'excel'; // reuse excel pipeline
        state.excelState  = null;
        state.status      = 'RUNNING';
        state.processed   = 0;
        state.failed      = 0;
        state.retryCount  = 0;
        state.startTime   = Date.now();
        state.batchTimes  = [];
        state.activeBatch = null;
        state.generationStarted = false;
        state.newChatPerBatch = msg.newChatPerBatch || false;
        state.batchDelay      = Math.max(0, Number(msg.batchDelay) || 0);

        // Store the synthetic raw file into the pending queue state
        // We piggyback on the excelState mechanism using a virtual file
        state.rawFile  = msg.file; // { id, name, excelChunks: [text] }
        state.total    = msg.file?.excelChunks?.length || 1;

        broadcastStatus();
        runNextRawBatch(); // intentionally not awaited

        sendResponse({ ok: true });
        break;
      }

      // ── RECOVER_STATE ────────────────────────────────────────────────────
      case 'RECOVER_STATE': {
        if (state.status === 'RUNNING' && state.activeBatch && state.generationStarted) {
          sendResponse({
            recovering: true,
            batchIndex: state.activeBatch.batchIndex,
            fileNames: state.activeBatch.fileNames,
            totalBatches: state.total,
          });
          updateWidget();
        } else {
          sendResponse({ recovering: false, status: state.status });
        }
        break;
      }

      // ── PAUSE_JOB ────────────────────────────────────────────────────────
      case 'PAUSE_JOB': {
        state.status = 'PAUSED';
        clearWatchdog();
        broadcastStatus();
        sendResponse({ ok: true });
        break;
      }

      // ── RATE_LIMIT_RETRY ─────────────────────────────────────────────────
      case 'RATE_LIMIT_RETRY': {
        if (state.status === 'RUNNING' || state.status === 'PAUSED_RETRYING') {
          state.status = 'PAUSED_RETRYING';
          state.consecutiveRateLimits = (state.consecutiveRateLimits || 0) + 1;
          const delaySec = state.consecutiveRateLimits * 10;
          
          clearWatchdog();
          
          if (state.activeTabId) {
            chrome.tabs.sendMessage(state.activeTabId, {
              action: 'UPDATE_WIDGET_STATE',
              status: `Rate Limit Hit. Retrying in ${delaySec}s...`,
              total: state.total,
              processed: state.processed,
              remaining: Math.max(0, state.total - state.processed - state.failed),
              failed: state.failed,
              jobMode: state.jobMode || 'excel'
            }).catch(() => {});
          }
          broadcastStatus();
          
          setTimeout(() => {
            if (state.status === 'PAUSED_RETRYING') {
              state.status = 'RUNNING';
              broadcastStatus();
              if (state.activeBatch) {
                retryCurrentBatch();
              }
            }
          }, delaySec * 1000);
        }
        sendResponse({ ok: true });
        break;
      }

      // ── RESUME_JOB ───────────────────────────────────────────────────────
      case 'RESUME_JOB': {
        if (state.status === 'PAUSED') {
          state.status = 'RUNNING';
          broadcastStatus();
          
          if (state.activeBatch) {
            retryCurrentBatch(); // re-inject the paused batch
          } else {
            // start next batch based on mode
            if (state.jobMode === 'pdf') {
              runNextPdfBatch();
            } else if (state.rawFile) {
              runNextRawBatch();
            } else {
              runNextExcelBatch();
            }
          }
        }
        sendResponse({ ok: true });
        break;
      }

      // ── STOP_JOB ─────────────────────────────────────────────────────────
      case 'STOP_JOB': {
        state.status = 'IDLE';
        state.activeBatch = null;
        state.rawFile = null;
        state.totalFileCount = 0;
        state.processedFileCount = 0;
        clearWatchdog();
        broadcastStatus();
        if (state.activeTabId !== null) {
          chrome.tabs.sendMessage(state.activeTabId, { action: 'STOP_INJECTION' }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      // ── CLEAR_DATA ───────────────────────────────────────────────────────
      case 'CLEAR_DATA': {
        state.status      = 'IDLE';
        state.activeBatch = null;
        state.rawFile     = null;
        state.totalFileCount = 0;
        state.processedFileCount = 0;
        state.processed   = 0;
        state.failed      = 0;
        state.total       = 0;
        state.startTime   = null;
        state.batchTimes  = [];
        state.retryCount  = 0;
        clearWatchdog();
        broadcastStatus();
        sendResponse({ ok: true });
        break;
      }

      // ── BATCH_GENERATING ─────────────────────────────────────────────────
      case 'BATCH_GENERATING': {
        state.generationStarted = true;
        if (state.activeBatch) {
          for (const id of state.activeBatch.fileIds) {
            await updateFileStatus(id, 'processing');
          }
          broadcastStatus();
        }
        sendResponse({ ok: true });
        break;
      }

      // ── BATCH_EXTRACTED ──────────────────────────────────────────────────
      case 'BATCH_EXTRACTED': {
        if (!state.activeBatch) {
          sendResponse({ ok: false, reason: 'No active batch' });
          return;
        }

        // Record batch duration for rolling average
        state.batchTimes = [...state.batchTimes, Date.now() - state.activeBatch.startTime];
        clearWatchdog();

        // Persist extracted text
        await appendOutputBuffer(msg.text + '\n\n');

        // Advance Excel chunk pointer
        state.processed += 1;
        state.retryCount = 0;
        state.consecutiveRateLimits = 0; // reset on success

        // Route to correct pipeline
        const _interBatchMs = Math.max(500, (state.batchDelay || 0) * 1000);
        if (state.jobMode === 'pdf') {
          // Mark files in active batch as processed, track file-level counts
          (async () => {
            if (state.activeBatch) {
              const batchSize = state.activeBatch.fileIds.length;
              state.processedFileCount = (state.processedFileCount || 0) + batchSize;
              for (const id of state.activeBatch.fileIds) {
                await updateFileStatus(id, 'processed');
              }
            }
            state.activeBatch = null;
            broadcastStatus();
            setTimeout(runNextPdfBatch, _interBatchMs);
          })();
        } else if (state.rawFile) {
          state.activeBatch = null;
          broadcastStatus();
          setTimeout(runNextRawBatch, _interBatchMs);
        } else {
          state.activeBatch = null;
          if (state.excelState) {
            state.excelState.chunkIndex += 1;
          }
          broadcastStatus();
          setTimeout(runNextExcelBatch, _interBatchMs);
        }

        sendResponse({ ok: true });
        break;
      }

      // ── FATAL_ERROR ──────────────────────────────────────────────────────
      case 'FATAL_ERROR': {
        state.status = 'ERROR';
        clearWatchdog();
        broadcastStatus();
        sendSoundToContent('error'); // intentionally not awaited
        console.error('[FatalError] Reason:', msg.reason);
        sendResponse({ ok: true });
        break;
      }

      // ── GET_STATUS ───────────────────────────────────────────────────────
      case 'GET_STATUS': {
        const avgTime =
          state.batchTimes.length > 0
            ? state.batchTimes.reduce((a, b) => a + b, 0) / state.batchTimes.length
            : 0;
        sendResponse({
          ok: true,
          state: state.status,
          processed: state.processed,
          total: state.total,
          failed: state.failed,
          runTime: state.startTime !== null ? Date.now() - state.startTime : 0,
          avgTime,
          activeBatch: state.activeBatch,
          activeTabId: state.activeTabId,
        });
        break;
      }

      // ── PING ─────────────────────────────────────────────────────────────
      case 'PING': {
        sendResponse({ ok: true });
        break;
      }

      default: {
        sendResponse({ ok: false, reason: `Unknown action: ${msg.action}` });
      }
    }
  })();

  // Return true to keep the message channel open for async sendResponse
  return true;
});

// ─────────────────────────────────────────────
// Tab lifecycle listeners
// ─────────────────────────────────────────────

/**
 * If the user closes the active AI Studio tab while a job is running,
 * pause the job automatically so no data is lost.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.activeTabId) {
    state.activeTabId = null;
    if (state.status === 'RUNNING') {
      state.status = 'PAUSED';
      clearWatchdog();
      broadcastStatus();
      console.warn('[TabRemoved] Active AI Studio tab closed — job paused automatically.');
    }
  }
});

// ─────────────────────────────────────────────
// Extension lifecycle listeners
// ─────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  openDB().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  openDB().catch(console.error);
});
