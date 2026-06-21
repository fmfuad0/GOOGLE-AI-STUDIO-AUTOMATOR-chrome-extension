/**
 * @fileoverview Content Script — AI Studio Automator (AI Studio Only)
 * Injected into https://aistudio.google.com/* pages.
 *
 * Responsibilities:
 *  1. Inject a draggable floating status widget on the AI Studio page
 *  2. Receive INJECT_EXCEL_PROMPT commands and run the full AI Studio automation pipeline
 *  3. Simulate Angular-compatible text injection and button clicks
 *  4. Monitor AI Studio generation and detect rate-limit / error states
 *  5. Extract and return the model response text
 *  6. Handle audio playback for success/error notifications
 */

(function () {
  'use strict';

  // ─── Register message listener ONCE, unconditionally ─────────────────────
  // MUST run before any guard so messages always reach the content script
  // even after programmatic re-injection.
  if (!window.__listenerRegistered) {
    window.__listenerRegistered = true;

    // ── Helpers needed by the listener ──────────────────────────────────────
    const _sleep = ms => new Promise(r => setTimeout(r, ms));

    /**
     * Polls for a DOM element by selector until found or timeout.
     * @param {string} selector
     * @param {number} timeout
     * @returns {Promise<Element|null>}
     */
    function _waitForElement(selector, timeout = 3000) {
      return new Promise((resolve) => {
        const start = Date.now();
        const iv = setInterval(() => {
          const el = document.querySelector(selector);
          if (el) { clearInterval(iv); resolve(el); }
          else if (Date.now() - start > timeout) { clearInterval(iv); resolve(null); }
        }, 100);
      });
    }

    /**
     * Injects text into the AI Studio Angular textarea using React/Angular-compatible methods.
     * @param {string} text
     */
    async function _injectAIStudioPrompt(text) {
      // Reveal textarea if hidden behind a toggle
      const toggleBtn = document.querySelector('button.runsettings-toggle-button');
      if (toggleBtn) { toggleBtn.click(); await _sleep(300); }

      // Wait for the Angular textarea (may be lazily rendered)
      let textarea = await _waitForElement('textarea[formcontrolname="promptText"]', 5000);
      if (!textarea) textarea = await _waitForElement('textarea', 2000);
      if (!textarea) { console.warn('[AI Studio] AI Studio: textarea not found'); return; }

      textarea.focus();
      await _sleep(150);

      // Clear existing content
      textarea.value = '';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      await _sleep(100);

      // Use native value setter to bypass Angular's value tracking
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(textarea, text);

      // Dispatch a full event suite for Angular change detection
      textarea.dispatchEvent(new KeyboardEvent('keydown',  { key: 'a', bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keypress', { key: 'a', bubbles: true }));
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent('keyup',    { key: 'a', bubbles: true }));
      await _sleep(300);

      // execCommand fallback if native setter failed
      if (!textarea.value || textarea.value.trim() === '') {
        textarea.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
        textarea.dispatchEvent(new Event('input',  { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        await _sleep(200);
      }

      console.log('[AI Studio] Textarea injected, value length:', textarea.value.length);
    }

    /**
     * Converts Base64 files to File objects and injects them into AI Studio.
     * @param {Array<{name:string, type:string, base64Data:string}>} filesData
     */
    async function _injectAIStudioPDFs(filesData) {
      if (!filesData || filesData.length === 0) return false;

      function base64ToBlob(base64, type) {
        const binStr = atob(base64);
        const len = binStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binStr.charCodeAt(i);
        }
        return new Blob([bytes], { type });
      }

      const dt = new DataTransfer();
      for (const fd of filesData) {
        const blob = base64ToBlob(fd.base64Data, fd.type || 'application/pdf');
        const file = new File([blob], fd.name, { type: fd.type || 'application/pdf' });
        dt.items.add(file);
      }

      // Try file input first
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[AI Studio] Injected PDF files via input element');
        await _sleep(800);
        return true;
      }

      // Fallback: Dispatch a drop event
      const dropzone = document.querySelector('ms-chat-window') || document.querySelector('main') || document.body;
      const dropEvent = new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true
      });
      dropzone.dispatchEvent(dropEvent);
      console.log('[AI Studio] Injected PDF files via Drag-and-Drop fallback');
      await _sleep(800);
      return true;
    }

    /**
     * Clicks the AI Studio "New Chat" button if the setting is enabled.
     */
    async function _clickNewChatButton() {
      const newChatBtn = document.querySelector('a[href*="/prompts/new_chat"]');
      if (newChatBtn) {
        newChatBtn.click();
        console.log('[AI Studio] Clicked New Chat button');
        await _sleep(2000); // give the page time to initialize new chat
      } else {
        console.warn('[AI Studio] New Chat button not found');
      }
    }

    /**
     * Triggers an automatic retry when a rate limit is hit.
     * Clears the local status override so the background's countdown message
     * can show through the widget immediately.
     */
    function _triggerRateLimitRetry() {
      _localOverride = null; // allow background UPDATE_WIDGET_STATE to show through
      chrome.runtime.sendMessage({ action: 'RATE_LIMIT_RETRY' }).catch(() => {});
    }

    /**
     * Scrolls the page and chat containers to the very bottom to ensure elements render.
     */
    function _scrollToBottom() {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      const main = document.querySelector('main');
      if (main) main.scrollTo({ top: main.scrollHeight, behavior: 'smooth' });
      
      const scrollContainers = document.querySelectorAll('ms-chat-window, .scroll-container, .chat-history, [class*="scroll"]');
      scrollContainers.forEach(el => {
        try { el.scrollTop = el.scrollHeight; } catch (e) {}
      });
    }

    /**
     * Checks the page for any AI Studio error state (rate limit, internal error, quota, etc.).
     * Returns { hit: boolean, isInternal: boolean }.
     */
    function _checkForAnyError() {
      const errorSelectors = [
        '.model-error',
        '[class*="error-message"]',
        '[class*="model-error"]',
        'ms-error-message',
        '.error-container',
      ];
      for (const sel of errorSelectors) {
        const els = document.querySelectorAll(sel);
        if (!els.length) continue;
        const t = els[els.length - 1].innerText.toLowerCase();
        if (t.includes('rate limit') || t.includes('quota') ||
            t.includes('internal error') || t.includes('something went wrong') ||
            t.includes('an error occurred') || t.includes('429')) {
          return { hit: true, isInternal: t.includes('internal error') || t.includes('something went wrong') };
        }
      }
      // Scan only the AI Studio chat area (not our widget) for inline error banners
      const chatRoot = document.querySelector('ms-chat-window, ms-prompt-chat, main') || document.body;
      const chatText = chatRoot.innerText.toLowerCase();
      if (chatText.includes('an internal error has occurred') ||
          chatText.includes('something went wrong. please try again')) {
        return { hit: true, isInternal: true };
      }
      return { hit: false, isInternal: false };
    }

    /**
     * Extracts the last model response text using a waterfall of selectors.
     */
    function _extractLastModelText() {
      const candidateSelectors = [
        'ms-chat-turn[role="model"] .response-container-scrollable',
        'ms-chat-turn[role="model"] ms-markdown-viewer',
        'ms-chat-turn[role="model"]',
        '.very-large-text-container',
        'ms-response-chunk',
        'ms-text-chunk',
        '.model-response-text',
        '[class*="response-container"]',
        '[class*="model-turn"]',
      ];
      for (const sel of candidateSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length) {
          const t = (els[els.length - 1].innerText || els[els.length - 1].textContent || '').trim();
          if (t.length > 5) return t;
        }
      }
      return '';
    }

    /**
     * Clicks the AI Studio "Run" button, with Ctrl+Enter keyboard fallback.
     */
    async function _clickAIStudioRun() {
      // Wait up to 5 seconds for the Run button to become enabled
      for (let i = 0; i < 50; i++) {
        const btn =
          Array.from(document.querySelectorAll('button')).find(
            b => b.textContent.trim().toLowerCase() === 'run' && !b.disabled
          ) ||
          document.querySelector('button[mattooltip="Run"]:not([disabled])');

        if (btn) {
          btn.click();
          return;
        }
        await _sleep(100);
      }

      // Keyboard fallback — AI Studio sometimes uses Ctrl+Enter
      console.warn('[AI Studio] Run button never became enabled, trying Ctrl+Enter fallback');
      const textarea = document.querySelector('textarea[formcontrolname="promptText"]');
      if (textarea) {
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ctrlKey: true };
        textarea.dispatchEvent(new KeyboardEvent('keydown',  opts));
        textarea.dispatchEvent(new KeyboardEvent('keypress', opts));
        textarea.dispatchEvent(new KeyboardEvent('keyup',    opts));
      }
    }

    // ── Widget text helpers (used from within listener) ────────────────────
    let _localOverride = null;

    function _updateWidgetStatus(text) {
      if (text === null) {
        _localOverride = null;
        return;
      }
      _localOverride = text;
      const el = document.getElementById('aia-status');
      if (el) el.textContent = text;
    }

    function _updateWidgetFull(msg) {
      const set = (id, val) => { const e = document.getElementById(id); if (e && val !== undefined) e.textContent = val; };

      let displayTotal     = msg.total;
      let displayProcessed = msg.processed;
      let displayRemaining = msg.remaining;

      if (msg.jobMode === 'excel' && msg.rowsPerPrompt) {
        displayTotal     = msg.total     * msg.rowsPerPrompt;
        displayProcessed = msg.processed * msg.rowsPerPrompt;
        displayRemaining = msg.remaining * msg.rowsPerPrompt;
      }

      const typeLabel = (msg.jobMode === 'pdf') ? 'Files' : (msg.jobMode === 'raw' ? 'Chunks' : 'Rows');
      set('label-total',     `Total ${typeLabel}`);
      set('label-processed', `Processed ${typeLabel}`);
      set('label-remaining', `Remaining ${typeLabel}`);

      set('aia-total',     displayTotal);
      set('aia-processed', displayProcessed);
      set('aia-remaining', displayRemaining);
      set('aia-failed',    msg.failed);
      
      if (_localOverride) {
        set('aia-status', _localOverride);
      } else {
        set('aia-status', msg.status);
      }

      const formatTime = (ms) => {
        if (!ms) return '--';
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
      };
      
      set('aia-runtime', msg.runTime ? formatTime(msg.runTime) : '--');
      set('aia-avg',     msg.avgTime ? formatTime(msg.avgTime) : '--');
      
      if (msg.totalBatches > 0) {
        set('aia-batch-info', `Batch ${(msg.batchIndex || 0) + 1} of ${msg.totalBatches}`);
      } else {
        set('aia-batch-info', 'Waiting for job...');
      }

      // Progress ring
      const percent = msg.total > 0 ? Math.round((msg.processed / msg.total) * 100) : 0;
      set('aia-progress-text', percent + '%');
      const ring = document.getElementById('aia-progress-ring');
      if (ring) {
        const offset = 163.36 - (percent / 100) * 163.36;
        ring.style.strokeDashoffset = offset;
      }

      // Status dot and ring color
      const w = document.getElementById('aia-widget');
      if (w && (msg.status || _localOverride)) {
        const currentStatusText = _localOverride || msg.status || '';
        const lower = currentStatusText.toLowerCase();

        const isError   = lower.includes('error');
        const isPaused  = lower.includes('paused');
        const isExtract = lower.includes('extract') || lower.includes('complete');
        const isGen     = lower.includes('generat') || lower.includes('waiting');
        const isInject  = lower.includes('inject') || lower.includes('start') || lower.includes('send') || lower.includes('file') || lower.includes('prompt');
        const isRunning = lower.includes('running') && !isExtract && !isGen && !isInject;

        w.querySelector('#aia-status').className = 'aia-status-text'
          + (isError   ? ' aia-status-error'   : '')
          + ((isExtract||isGen||isInject||isRunning) ? ' aia-status-running'  : '')
          + (isPaused  ? ' aia-status-paused'   : '');

        const dot = document.getElementById('aia-glow-dot');
        if (dot) {
          if (isError) {
            dot.style.background = '#ea4335'; dot.style.boxShadow = '0 0 8px #ea4335'; dot.style.animation = 'none';
          } else if (isPaused) {
            dot.style.background = '#fbbc04'; dot.style.boxShadow = '0 0 8px #fbbc04'; dot.style.animation = 'none';
          } else if (isExtract) {
            dot.style.background = '#34a853'; dot.style.boxShadow = '0 0 8px #34a853'; dot.style.animation = 'aia-pulse 1s ease-in-out infinite';
          } else if (isGen) {
            dot.style.background = '#fbbc04'; dot.style.boxShadow = '0 0 8px #fbbc04'; dot.style.animation = 'aia-pulse 1.5s ease-in-out infinite';
          } else if (isInject) {
            dot.style.background = '#a8a8b8'; dot.style.boxShadow = '0 0 8px #a8a8b8'; dot.style.animation = 'aia-pulse 1.5s ease-in-out infinite';
          } else if (isRunning) {
            dot.style.background = '#34a853'; dot.style.boxShadow = '0 0 8px #34a853'; dot.style.animation = 'aia-pulse 2s ease-in-out infinite';
          } else {
            dot.style.background = '#8b8ba8'; dot.style.boxShadow = 'none'; dot.style.animation = 'none';
          }
        }
        if (ring) {
          if      (isError)   ring.style.stroke = '#ea4335';
          else if (isPaused)  ring.style.stroke = '#fbbc04';
          else if (isExtract) ring.style.stroke = '#34a853';
          else if (isGen)     ring.style.stroke = '#fbbc04';
          else if (isInject)  ring.style.stroke = '#a8a8b8';
          else                ring.style.stroke = '#4285f4';
        }
      }
    }

    // ── Keep-alive heartbeat — prevents service worker from sleeping ─────────
    setInterval(() => {
      try { chrome.runtime.sendMessage({ action: 'PING' }).catch(() => {}); } catch (e) {}
    }, 20_000);

    // ── Main message router ──────────────────────────────────────────────────
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.action) return false;

      switch (msg.action) {

        // ── UPDATE_WIDGET_STATE ────────────────────────────────────────────
        case 'UPDATE_WIDGET_STATE':
          _updateWidgetFull(msg);
          sendResponse({ ok: true });
          break;

        // ── INJECT_EXCEL_PROMPT ────────────────────────────────────────────
        // Core AI Studio automation pipeline. Injects the prompt, clicks Run,
        // waits for generation, extracts response, and reports back.
        case 'INJECT_EXCEL_PROMPT': {
          sendResponse({ ok: true });
          _updateWidgetStatus('Injecting prompt...');

          (async () => {
            try {
              if (msg.newChatPerBatch) {
                _updateWidgetStatus('Starting new chat...');
                await _clickNewChatButton();
              }

              // 1. Inject prompt text into AI Studio textarea
              await _injectAIStudioPrompt(msg.prompt);
              _updateWidgetStatus('Sending...');
              await _sleep(800);

              // 2. Click Run
              await _clickAIStudioRun();
              _updateWidgetStatus('Waiting for generation...');

              // 3. Wait for Stop button to appear (generation started)
              let stopAppeared = false;

              for (let i = 0; i < 3600 && !stopAppeared; i++) { // Max 30 mins to start
                await _sleep(500);

                const errCheck = _checkForAnyError();
                if (errCheck.hit) {
                  console.warn('[AI Studio] Error detected before generation:', errCheck);
                  _triggerRateLimitRetry();
                  return;
                }

                const btn = document.querySelector('.run-button');
                if (btn && btn.textContent.toLowerCase().includes('stop')) {
                  stopAppeared = true;
                } else {
                  // Fallback search
                  const anyStop = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('stop'));
                  if (anyStop) stopAppeared = true;
                }
              }

              if (stopAppeared) {
                chrome.runtime.sendMessage({ action: 'BATCH_GENERATING' }).catch(() => {});
                _updateWidgetStatus('Generating... ⏳');

                // 4. Wait for Stop to disappear and Run to reappear (generation done)
                let isRunning = true;
                let waitCycles = 0;
                let runSeenCount = 0;

                while (isRunning && waitCycles < 3600) { // Max 30 mins (3600 * 0.5s)
                  await _sleep(500);
                  waitCycles++;

                  const errCheck = _checkForAnyError();
                  if (errCheck.hit) {
                    console.warn('[AI Studio] Error detected mid-generation:', errCheck);
                    _triggerRateLimitRetry();
                    return;
                  }

                  const btn = document.querySelector('.run-button');
                  let text = btn ? btn.textContent.toLowerCase() : '';

                  let isStop = text.includes('stop');
                  let isRun = text.includes('run') || (btn && btn.getAttribute('mattooltip') === 'Run');

                  // Fallback to broad search if .run-button is not found
                  if (!btn) {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    isStop = !!buttons.find(b => b.textContent.toLowerCase().includes('stop'));
                    isRun = !!buttons.find(b => b.textContent.toLowerCase().includes('run') || b.getAttribute('mattooltip') === 'Run');
                  }

                  if (isStop) {
                    runSeenCount = 0; // Reset debounce
                  } else if (isRun) {
                    runSeenCount++;
                    if (runSeenCount >= 5) {
                      isRunning = false;
                    }
                  }
                }
              }

              // 4.5. 5 Second timer before extraction
              _scrollToBottom();
              for (let t = 5; t > 0; t--) {
                _updateWidgetStatus(`Extracting in ${t}s...`);
                await _sleep(1000);
              }

              // 5. Extract response text
              _updateWidgetStatus('Extracting response...');
              await _sleep(500);

              // Final error check before extracting
              const finalErrCheck = _checkForAnyError();
              if (finalErrCheck.hit) {
                console.warn('[AI Studio] Error detected before extraction.');
                _triggerRateLimitRetry();
                return;
              }

              let rawText = _extractLastModelText();

              // Strip trailing UI chrome like "Copy" buttons
              rawText = rawText.replace(/\bCopy\b\s*$/m, '').trim();

              if (!rawText) {
                console.warn('[AI Studio] Empty response from model - triggering retry.');
                _triggerRateLimitRetry();
                return;
              }

              // Wrap with section header for output parsing.
              // Synthetic filenames (system-prompt-only / raw-input mode) use GENERATED label.
              const _syntheticNames = ['system_prompt_only.txt', 'raw_input.txt'];
              const _isGenerated = !msg.fileName || _syntheticNames.includes(msg.fileName);
              let _fileLabel;
              if (_isGenerated) {
                _fileLabel = 'GENERATED';
              } else {
                const batchNum = msg.batchIndex + 1;
                const rangeStr = msg.rowRange && msg.rowRange !== 'Unknown' ? `, Rows ${msg.rowRange}` : '';
                _fileLabel = `${msg.fileName} (Batch ${batchNum}${rangeStr})`;
              }
              const text = `\n\n${'='.repeat(52)}\nFILE: ${_fileLabel}\n${'='.repeat(52)}\n` + rawText;

              // 6. Inline rate limit check (text content)
              if (
                rawText.toLowerCase().includes("you've reached your rate limit") ||
                rawText.toLowerCase().includes('quota exceeded') ||
                rawText.toLowerCase().includes('an internal error has occurred')
              ) {
                console.warn('[AI Studio] Rate limit / error phrase found in response text.');
                _triggerRateLimitRetry();
                return;
              }

              _updateWidgetStatus('✓ Batch complete!');
              chrome.runtime.sendMessage({ action: 'BATCH_EXTRACTED', text, batchIndex: msg.batchIndex }).catch(() => {});

              // Clear override so background can show "Waiting..." or "IDLE"
              setTimeout(() => { _updateWidgetStatus(null); }, 1000);

            } catch (err) {
              console.error('[AI Studio] INJECT_EXCEL_PROMPT error:', err);
              _updateWidgetStatus('Error: ' + err.message);
              chrome.runtime.sendMessage({ action: 'FATAL_ERROR', reason: 'EXCEL_INJECT_FAILED' }).catch(() => {});
            }
          })();
          break;
        }

        // ── INJECT_PDF_PROMPT ──────────────────────────────────────────────
        // Injects PDF files, optional system prompt, clicks run and extracts.
        case 'INJECT_PDF_PROMPT': {
          sendResponse({ ok: true });
          _updateWidgetStatus('Injecting PDFs...');

          (async () => {
            try {
              if (msg.newChatPerBatch) {
                _updateWidgetStatus('Starting new chat...');
                await _clickNewChatButton();
              }

              // 1. Inject PDF Files
              await _injectAIStudioPDFs(msg.files);
              _updateWidgetStatus('Files uploaded...');
              await _sleep(800);

              // 1.5 Inject System Prompt if present
              if (msg.prompt) {
                await _injectAIStudioPrompt(msg.prompt);
                _updateWidgetStatus('Prompt injected...');
                await _sleep(500);
              }

              // 2. Click Run
              await _clickAIStudioRun();
              _updateWidgetStatus('Waiting for generation...');

              // 3. Wait for Stop button to appear (generation started)
              let stopAppeared = false;
              
              for (let i = 0; i < 3600 && !stopAppeared; i++) { // Max 30 mins to start
                await _sleep(500);

                const errCheck = _checkForAnyError();
                if (errCheck.hit) {
                  console.warn('[AI Studio] PDF: Error detected before generation:', errCheck);
                  _triggerRateLimitRetry();
                  return;
                }

                const btn = document.querySelector('.run-button');
                if (btn && btn.textContent.toLowerCase().includes('stop')) {
                  stopAppeared = true;
                } else {
                  const anyStop = Array.from(document.querySelectorAll('button')).find(b => b.textContent.toLowerCase().includes('stop'));
                  if (anyStop) stopAppeared = true;
                }
              }

              if (stopAppeared) {
                chrome.runtime.sendMessage({ action: 'BATCH_GENERATING' }).catch(() => {});
                _updateWidgetStatus('Generating... ⏳');

                // 4. Wait for Stop to disappear and Run to reappear (generation done)
                let isRunning = true;
                let waitCycles = 0;
                let runSeenCount = 0;

                while (isRunning && waitCycles < 3600) { // Max 30 mins
                  await _sleep(500);
                  waitCycles++;
                  
                  const errCheck = _checkForAnyError();
                  if (errCheck.hit) {
                    console.warn('[AI Studio] PDF: Error detected mid-generation:', errCheck);
                    _triggerRateLimitRetry();
                    return;
                  }

                  const btn = document.querySelector('.run-button');
                  let text = btn ? btn.textContent.toLowerCase() : '';
                  
                  let isStop = text.includes('stop');
                  let isRun = text.includes('run') || (btn && btn.getAttribute('mattooltip') === 'Run');
                  
                  // Fallback to broad search if .run-button is not found
                  if (!btn) {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    isStop = !!buttons.find(b => b.textContent.toLowerCase().includes('stop'));
                    isRun = !!buttons.find(b => b.textContent.toLowerCase().includes('run') || b.getAttribute('mattooltip') === 'Run');
                  }
                  
                  if (isStop) {
                    runSeenCount = 0; // Reset debounce
                  } else if (isRun) {
                    runSeenCount++;
                    if (runSeenCount >= 5) {
                      isRunning = false;
                    }
                  }
                }

                // 4.5. 5 Second timer before extraction
                _scrollToBottom();
                for (let t = 5; t > 0; t--) {
                  _updateWidgetStatus(`Extracting in ${t}s...`);
                  await _sleep(1000);
                }

                // 5. Extract response text
                _updateWidgetStatus('Extracting response...');
                await _sleep(500);

                // Final error check before extracting
                const finalErrCheck = _checkForAnyError();
                if (finalErrCheck.hit) {
                  console.warn('[AI Studio] PDF: Error detected before extraction.');
                  _triggerRateLimitRetry();
                  return;
                }

                let rawText = _extractLastModelText();
                rawText = rawText.replace(/\bCopy\b\s*$/m, '').trim();
                
                if (!rawText) {
                  console.warn('[AI Studio] PDF: Empty response from model - triggering retry.');
                  _triggerRateLimitRetry();
                  return;
                }
                
                // Wrap with file name header for output parsing
                const fileNames = msg.files.map(f => f.name).join(', ');
                const text = `\n\n${'='.repeat(52)}\nFILE: ${fileNames}\n${'='.repeat(52)}\n` + rawText;

                // 6. Rate limit check
                if (
                  rawText.toLowerCase().includes("you've reached your rate limit") ||
                  rawText.toLowerCase().includes("quota exceeded") ||
                  rawText.toLowerCase().includes('an internal error has occurred')
                ) {
                  console.warn('[AI Studio] PDF: Rate limit / error phrase detected in response.');
                  _triggerRateLimitRetry();
                  return;
                }

                _updateWidgetStatus('✓ Batch complete!');
                chrome.runtime.sendMessage({ action: 'BATCH_EXTRACTED', text, batchIndex: msg.batchIndex }).catch(() => {});
                
                // Clear override so background can show "Waiting..." or "IDLE"
                setTimeout(() => { _updateWidgetStatus(null); }, 1000);

              } else {
                throw new Error('Generation never started');
              }
            } catch (err) {
              console.error('[AI Studio] INJECT_PDF_PROMPT error:', err);
              _updateWidgetStatus('Error: ' + err.message);
              chrome.runtime.sendMessage({ action: 'FATAL_ERROR', reason: 'PDF_INJECT_FAILED' }).catch(() => {});
            }
          })();
          break;
        }

        // ── PLAY_SOUND ────────────────────────────────────────────────────
        case 'PLAY_SOUND':
          if (typeof playSound === 'function') playSound(msg.type);
          sendResponse({ ok: true });
          break;

        // ── STOP_INJECTION ────────────────────────────────────────────────
        case 'STOP_INJECTION':
          _updateWidgetStatus('Stopped');
          sendResponse({ ok: true });
          window.location.reload();
          break;

        default:
          sendResponse({ ok: false, error: 'Unknown action: ' + msg.action });
      }
      return true;
    });

    // State recovery check on each page load
    setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ action: 'RECOVER_STATE' }, (res) => {
          if (res && res.recovering) {
            console.info('[AI Studio] Active job detected — widget updated.');
          }
        });
      } catch (e) { console.warn('[AI Studio] RECOVER_STATE check failed:', e.message); }
    }, 1000);

    console.info('[AI Studio Automator] Message listener registered on:', window.location.href);
  }

  // ─── Guard: prevent double widget injection on SPA navigations ────────────
  const _existingWidget = document.getElementById('aia-widget');
  if (_existingWidget && document.body.contains(_existingWidget)) {
    return; // Listener registered above; widget already present
  } else if (_existingWidget) {
    _existingWidget.remove();
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  /** @param {number} ms @returns {Promise<void>} */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /**
   * Formats milliseconds into HH:MM:SS.
   * @param {number} ms
   * @returns {string}
   */
  function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
  }

  // ─────────────────────────────────────────────
  // Widget: Inject styles
  // ─────────────────────────────────────────────

  const widgetStyle = document.createElement('style');
  widgetStyle.id = 'aia-widget-styles';
  widgetStyle.textContent = `
    #aia-widget * { box-sizing: border-box !important; margin: 0 !important; padding: 0 !important; }
    #aia-widget {
      position: fixed !important;
      bottom: 80px !important;
      left: 80px !important;
      top: auto !important;
      right: auto !important;
      z-index: 2147483647 !important;
      width: 240px !important;
      background: linear-gradient(145deg, rgba(13,17,31,0.85) 0%, rgba(8,12,22,0.95) 100%) !important;
      backdrop-filter: blur(28px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(28px) saturate(180%) !important;
      border: 1px solid rgba(255,255,255,0.08) !important;
      border-radius: 18px !important;
      box-shadow: 0 24px 64px rgba(0,0,0,0.8), inset 0 1px 1px rgba(255,255,255,0.05) !important;
      font-family: 'Inter', system-ui, -apple-system, sans-serif !important;
      font-size: 13px !important;
      color: #e8edf4 !important;
      user-select: none !important;
      -webkit-user-select: none !important;
      touch-action: none !important;
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1) !important;
    }
    #aia-widget:hover {
      box-shadow: 0 28px 72px rgba(0,0,0,0.9), inset 0 1px 1px rgba(255,255,255,0.08) !important;
      border-color: rgba(255,255,255,0.12) !important;
    }
    #aia-widget.aia-minimized #aia-widget-body { display: none !important; }
    #aia-widget-header {
      background: transparent !important;
      padding: 14px 16px !important;
      cursor: grab !important;
      border-radius: 18px 18px 0 0 !important;
      border-bottom: 1px solid rgba(255,255,255,0.04) !important;
      font-weight: 600 !important;
      font-size: 13px !important;
      letter-spacing: 0.02em !important;
      color: #fff !important;
      display: flex !important;
      align-items: center !important;
      gap: 10px !important;
      -webkit-font-smoothing: antialiased !important;
    }
    .aia-title-text {
      background: linear-gradient(90deg, #60a5fa 0%, #a78bfa 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      text-shadow: 0 2px 12px rgba(96,165,250,0.2);
    }
    #aia-widget.aia-minimized #aia-widget-header { border-radius: 18px !important; border-bottom: none !important; }
    #aia-widget-header.grabbing { cursor: grabbing !important; }
    #aia-minimize-btn {
      margin-left: auto !important;
      background: rgba(255,255,255,0.05) !important;
      border: 1px solid rgba(255,255,255,0.05) !important;
      color: rgba(255,255,255,0.85) !important;
      cursor: pointer !important;
      font-size: 14px !important;
      line-height: 1 !important;
      width: 26px !important;
      height: 26px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      border-radius: 8px !important;
      transition: all 0.2s !important;
      flex-shrink: 0 !important;
    }
    #aia-minimize-btn:hover { background: rgba(255,255,255,0.15) !important; border-color: rgba(255,255,255,0.1) !important; color: #fff !important; }
    #aia-widget-body {
      padding: 14px 16px !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 8px !important;
    }
    .aia-row {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      min-height: 22px !important;
      padding: 0 2px !important;
    }
    .aia-label  { color: #94a3b8 !important; font-size: 11px !important; font-weight: 500 !important; letter-spacing: 0.01em !important; }
    .aia-value  { font-size: 12.5px !important; font-weight: 600 !important; text-align: right !important; color: #f8fafc !important; font-variant-numeric: tabular-nums; }
    .aia-divider { height: 1px !important; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent) !important; margin: 6px 0 !important; flex-shrink: 0 !important; }
    .aia-status-text {
      font-size: 11.5px !important;
      font-weight: 600 !important;
      text-align: right !important;
      max-width: 150px !important;
      word-break: break-word !important;
      line-height: 1.4 !important;
      color: #93c5fd !important;
    }
    .aia-status-running { color: #34d399 !important; animation: aia-pulse 2s ease-in-out infinite !important; text-shadow: 0 0 10px rgba(52,211,153,0.3) !important; }
    .aia-status-paused  { color: #fbbf24 !important; }
    .aia-status-error   { color: #f87171 !important; text-shadow: 0 0 10px rgba(248,113,113,0.3) !important; }
    .aia-status-success { color: #34d399 !important; }
    #aia-batch-info {
      font-size: 10px !important;
      color: #64748b !important;
      text-align: center !important;
      margin-top: 4px !important;
      letter-spacing: 0.04em !important;
      text-transform: uppercase !important;
      font-weight: 600 !important;
    }
    @keyframes aia-pulse { 0%,100% { opacity:1; filter: brightness(1); } 50% { opacity:0.6; filter: brightness(1.2); } }
    @media (max-width: 768px) {
      #aia-widget { width: 190px !important; bottom: 20px !important; left: 20px !important; }
      #aia-widget-header { padding: 8px 10px !important; font-size: 11px !important; }
      #aia-widget-body { padding: 8px 10px !important; }
      .aia-value { font-size: 11px !important; }
      .aia-label { font-size: 10px !important; }
    }
  `;
  (document.head || document.documentElement).appendChild(widgetStyle);

  // ─────────────────────────────────────────────
  // Widget: Create DOM
  // ─────────────────────────────────────────────

  const widget = document.createElement('div');
  widget.id = 'aia-widget';
  widget.innerHTML = `
    <div id="aia-widget-header">
      <div style="display:flex; align-items:center; gap:8px;">
        <span id="aia-glow-dot" style="width:8px; height:8px; border-radius:50%; background:#8b8ba8; display:inline-block; transition: background 0.3s, box-shadow 0.3s;"></span>
        <span class="aia-title-text">✦ AI Studio Automator</span>
      </div>
      <button id="aia-minimize-btn" title="Minimize / Expand">−</button>
    </div>
    <div id="aia-widget-body">
      <div style="display: flex; align-items: center; justify-content: center; margin: 5px 0 10px 0;">
        <div style="position: relative; width: 60px; height: 60px;">
          <svg width="60" height="60" viewBox="0 0 60 60" style="transform: rotate(-90deg);">
            <circle cx="30" cy="30" r="26" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="4"></circle>
            <circle id="aia-progress-ring" cx="30" cy="30" r="26" fill="none" stroke="url(#ringGradient)" stroke-width="4"
              stroke-dasharray="163.36" stroke-dashoffset="163.36" stroke-linecap="round"
              style="transition: stroke-dashoffset 0.5s ease-in-out, stroke 0.3s; filter: drop-shadow(0 0 4px rgba(96,165,250,0.5));">
            </circle>
            <defs>
              <linearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#60a5fa" />
                <stop offset="100%" stop-color="#a78bfa" />
              </linearGradient>
            </defs>
          </svg>
          <div id="aia-progress-text" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #fff;">0%</div>
        </div>
      </div>
      <div class="aia-row">
        <span class="aia-label" id="label-total">Total Rows</span>
        <span class="aia-value" id="aia-total">—</span>
      </div>
      <div class="aia-row">
        <span class="aia-label" id="label-processed">Processed Rows</span>
        <span class="aia-value" id="aia-processed">—</span>
      </div>
      <div class="aia-row">
        <span class="aia-label" id="label-remaining">Remaining Rows</span>
        <span class="aia-value" id="aia-remaining">—</span>
      </div>
      <div class="aia-row">
        <span class="aia-label">Failed</span>
        <span class="aia-value" id="aia-failed">—</span>
      </div>
      <div class="aia-divider"></div>
      <div class="aia-row">
        <span class="aia-label">Status</span>
        <span class="aia-status-text" id="aia-status">Waiting...</span>
      </div>
      <div class="aia-row">
        <span class="aia-label">Run Time</span>
        <span class="aia-value" id="aia-runtime">—</span>
      </div>
      <div class="aia-row">
        <span class="aia-label">Avg/Chunk</span>
        <span class="aia-value" id="aia-avg">—</span>
      </div>
      <div class="aia-divider"></div>
      <div id="aia-batch-info">Waiting for job...</div>
    </div>
  `;
  document.body.appendChild(widget);

  // ─────────────────────────────────────────────
  // Widget: Minimize toggle
  // ─────────────────────────────────────────────

  const minimizeBtn = document.getElementById('aia-minimize-btn');
  minimizeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    widget.classList.toggle('aia-minimized');
    minimizeBtn.textContent = widget.classList.contains('aia-minimized') ? '+' : '−';
  });

  // ─────────────────────────────────────────────
  // Widget: Drag logic — pointer capture
  // ─────────────────────────────────────────────

  const widgetHeader = document.getElementById('aia-widget-header');
  let _dragging = false;
  let _startX = 0, _startY = 0, _origLeft = 0, _origTop = 0;

  function getWidgetPos() {
    const rect = widget.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }

  widgetHeader.addEventListener('pointerdown', (e) => {
    if (e.target === minimizeBtn) return;
    e.preventDefault(); e.stopPropagation();
    _dragging = true;
    const pos = getWidgetPos();
    _startX = e.clientX; _startY = e.clientY;
    _origLeft = pos.left; _origTop = pos.top;
    widget.style.setProperty('left',   _origLeft + 'px', 'important');
    widget.style.setProperty('top',    _origTop  + 'px', 'important');
    widget.style.setProperty('bottom', 'auto',           'important');
    widget.style.setProperty('right',  'auto',           'important');
    widgetHeader.classList.add('grabbing');
    widgetHeader.setPointerCapture(e.pointerId);
  });

  widgetHeader.addEventListener('pointermove', (e) => {
    if (!_dragging) return;
    e.preventDefault();
    const dx = e.clientX - _startX;
    const dy = e.clientY - _startY;
    let newLeft = Math.max(0, Math.min(window.innerWidth  - widget.offsetWidth,  _origLeft + dx));
    let newTop  = Math.max(0, Math.min(window.innerHeight - widget.offsetHeight, _origTop  + dy));
    widget.style.setProperty('left', newLeft + 'px', 'important');
    widget.style.setProperty('top',  newTop  + 'px', 'important');
  });

  function stopDrag(e) {
    if (!_dragging) return;
    _dragging = false;
    widgetHeader.classList.remove('grabbing');
    if (e && e.pointerId != null) {
      try { widgetHeader.releasePointerCapture(e.pointerId); } catch(_) {}
    }
  }

  widgetHeader.addEventListener('pointerup',     stopDrag);
  widgetHeader.addEventListener('pointercancel', stopDrag);

  // Keep widget in bounds on screen resize
  window.addEventListener('resize', () => {
    const rect = widget.getBoundingClientRect();
    if (rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
      let newLeft = Math.max(0, Math.min(window.innerWidth - widget.offsetWidth, rect.left));
      let newTop = Math.max(0, Math.min(window.innerHeight - widget.offsetHeight, rect.top));
      widget.style.setProperty('left', newLeft + 'px', 'important');
      widget.style.setProperty('top', newTop + 'px', 'important');
    }
  });

  // ─────────────────────────────────────────────
  // Widget: Full update function
  // ─────────────────────────────────────────────

  /**
   * Updates all widget fields from a status data object.
   * @param {object} data
   */
  function updateWidget(data) {
    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el && val !== undefined && val !== null) el.textContent = val;
    };

    if (data.total     !== undefined) setText('aia-total',     data.total);
    if (data.processed !== undefined) setText('aia-processed', data.processed);
    if (data.remaining !== undefined) setText('aia-remaining', data.remaining);
    if (data.failed    !== undefined) setText('aia-failed',    data.failed);
    if (data.runTime   !== undefined) setText('aia-runtime',   formatTime(data.runTime));
    if (data.avgTime   !== undefined && data.avgTime > 0) {
      setText('aia-avg', Math.round(data.avgTime / 1000) + 's');
    }
    if (data.batchIndex !== undefined) {
      const batchInfo = document.getElementById('aia-batch-info');
      if (batchInfo) batchInfo.textContent = `Chunk ${data.batchIndex + 1} / ${data.totalBatches || '?'}`;
    }
    if (data.status) updateWidgetStatus(data.status);
  }

  /**
   * Sets the widget status text with appropriate color class.
   * @param {string} text
   */
  function updateWidgetStatus(text) {
    const el = document.getElementById('aia-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'aia-status-text';

    const lower = text.toLowerCase();
    if (lower.includes('error') || lower.includes('expired') || lower.includes('limit') ||
        lower.includes('timeout') || lower.includes('failed') || lower.includes('⚠') || lower.includes('⛔')) {
      el.classList.add('aia-status-error');
    } else if (lower.includes('pause')) {
      el.classList.add('aia-status-paused');
    } else if (lower.includes('complete') || lower.includes('✓') || lower.includes('done')) {
      el.classList.add('aia-status-success');
    } else if (text !== 'Waiting...') {
      el.classList.add('aia-status-running');
    }
  }

  // ─────────────────────────────────────────────
  // Audio Playback
  // ─────────────────────────────────────────────

  /**
   * Plays a notification sound via chrome.runtime.getURL.
   * @param {'success'|'error'} type
   */
  function playSound(type) {
    const file = type === 'success' ? 'assets/ding.mp3' : 'assets/alert.mp3';
    try {
      const url = chrome.runtime.getURL(file);
      const audio = new Audio(url);
      audio.volume = 0.65;
      audio.play().catch(e => console.warn('[AI Studio] Audio play failed:', e.message));
    } catch (e) {
      console.warn('[AI Studio] Audio error:', e.message);
    }
  }

  // ─────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────

  console.info('[AI Studio Automator] Widget injected on:', window.location.href);

})(); // end IIFE
