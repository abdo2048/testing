// ==UserScript==
// @name         Ask Brave Chat Exporter-3
// @namespace    http://tampermonkey.net/
// @version      1.4.0
// @description  Export Ask Brave conversations to Markdown and/or HTML (API mode + clipboard-write capture; no clipboard read needed — works on long conversations & Firefox)
// @author       abdo2048
// @match        https://search.brave.com/ask*
// @require      https://cdn.jsdelivr.net/npm/marked/marked.min.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    /* global marked */

    // =============================================
    // CONFIGURATION
    // =============================================
    const CONFIG = {
        COPY_DELAY: 200, // ms between copy operations (kept for compat; capture loop uses polling)
        MAX_TITLE_LENGTH: 40,
        EXPORT_MODE: 'auto',           // 'auto' | 'api' | 'clipboard'
        INCLUDE_RESOURCES: 'cited'     // 'none' | 'cited' | 'all'
    };

    // =============================================
    // API-MODE STATE CAPTURE
    // Passive network interceptor installed at document-start.
    // It never modifies requests; it only clones responses it recognizes.
    // =============================================
    const __ABX = window.__braveExporterData || (window.__braveExporterData = {
        convs: {},          // conversationId -> { turns: [], updatedAt }
        lastSeenAt: null,   // timestamp of last captured chunk
        chunks: 0           // number of captured stream/state payloads
    });
    window.__ABX = __ABX;

    // ---- Clipboard WRITE capture ----
    // Firefox blocks navigator.clipboard.readText() without transient user
    // activation, and the first await inside the export loop consumes it.
    // Instead of reading the clipboard, we tap the page's *writes* and stash
    // whatever Brave's own "Copy" buttons put there.
    const __ABX_CLIP = (window.__ABX_clipboardCapture = { text: null, at: 0 });

    (function patchClipboardWriters() {
        try {
            const clip = navigator.clipboard;
            if (clip) {
                const origWriteText = clip.writeText;
                if (typeof origWriteText === 'function') {
                    clip.writeText = function(text) {
                        try {
                            __ABX_CLIP.text = String(text);
                            __ABX_CLIP.at = Date.now();
                        } catch (e) {}
                        return origWriteText.apply(this, arguments);
                    };
                }
                const origWrite = clip.write;
                if (typeof origWrite === 'function') {
                    clip.write = function(items) {
                        try {
                            const item = items && items[0];
                            if (item && item.types && item.types.indexOf('text/plain') !== -1) {
                                item.getType('text/plain').then(b => b.text()).then(t => {
                                    __ABX_CLIP.text = String(t);
                                    __ABX_CLIP.at = Date.now();
                                }).catch(() => {});
                            }
                        } catch (e) {}
                        return origWrite.apply(this, arguments);
                    };
                }
            }
        } catch (e) {}

        try {
            const origExec = document.execCommand;
            if (typeof origExec === 'function') {
                document.execCommand = function(cmd) {
                    if (cmd === 'copy') {
                        try {
                            const sel = window.getSelection();
                            if (sel && sel.rangeCount > 0) {
                                const t = sel.toString();
                                if (t) {
                                    __ABX_CLIP.text = t;
                                    __ABX_CLIP.at = Date.now();
                                }
                            }
                        } catch (e) {}
                    }
                    return origExec.apply(this, arguments);
                };
            }
        } catch (e) {}
    })();

    function abxConv(id) {
        if (!id) id = '__unknown__';
        if (!__ABX.convs[id]) __ABX.convs[id] = { turns: [], updatedAt: 0 };
        return __ABX.convs[id];
    }

    function abxTurn(conv, index) {
        if (index === undefined || index === null) index = conv.turns.length;
        let t = conv.turns.find(x => x.index === index);
        if (!t) {
            t = {
                index: index,
                question: null,
                answerMd: '',
                citationsById: {},   // key -> {number, url, title}
                augmentations: [],   // {type, query}
                ragUrls: [],
                sawFinal: false
            };
            conv.turns.push(t);
            conv.turns.sort((a, b) => a.index - b.index);
        }
        return t;
    }

    function abxHandleEvent(evt) {
        try {
            if (!evt || typeof evt !== 'object' || !evt.type) return;
            const conv = abxConv(evt.conversation);
            const turn = abxTurn(conv, evt.index);
            conv.updatedAt = Date.now();
            __ABX.lastSeenAt = Date.now();

switch (evt.type) {

    // The answer text — comes in fragments.
    case 'text_delta':
        if (typeof evt.delta === 'string') turn.answerMd += evt.delta;
        break;

    // End of a text block — carries the block's full text.
    // Only use it if deltas somehow got dropped.
    case 'text_stop':
        if (typeof evt.text === 'string' && !turn.answerMd && evt.text) {
            turn.answerMd = evt.text;
        }
        break;

    // Citations — note: flat shape, not nested under evt.citation.
    case 'augment_with_inline_citation': {
        const url = evt.url || '';
        if (!url) break;
        if (!turn.citationsById[url]) {
            turn.citationsById[url] = {
                url:     url,
                title:   evt.title   || '',
                snippet: evt.snippet || '',
                favicon: evt.favicon || ''
            };
        }
        break;
    }

    // Tool-backed augmentations — all share the same outer shape.
    case 'augment_with_news':
    case 'augment_with_discussions':
    case 'augment_with_videos':
    case 'augment_with_web':
    case 'augment_with_places':
    case 'augment_with_products':
    case 'tool_use': {
        let name = evt.type;
        let q = evt.query || '';
        const tu = evt.tool_use || {};
        if (tu.name) name = tu.name;
        if (!q && tu.arguments && tu.arguments.q) q = tu.arguments.q;
        turn.augmentations.push({ type: name, query: q });
        break;
    }

    // Web search pass — dedupe urls.
    case 'rag':
        if (Array.isArray(evt.urls)) {
            evt.urls.forEach(u => {
                if (u && turn.ragUrls.indexOf(u) === -1) turn.ragUrls.push(u);
            });
        }
        break;

    // Present in some captures; harmless if absent.
    case 'final':
        turn.sawFinal = true;
        break;

    // Explicitly ignored: text_start, thinking_summary, reasoning_progress,
    // inline_entity, usage, followups, debug_labels.
    default:
        break;
}
        } catch (e) { /* never break the page */ }
    }

    // Parse an SSE body text ("data: {...}\n\n" lines) and feed events
// Accepts either newline-delimited JSON (what Brave actually sends) or
// classic SSE "data: {...}" lines. One line == one JSON object.
function abxParseSSE(text) {
    __ABX.chunks++;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line) continue;
        if (line.indexOf('data:') === 0) line = line.slice(5).trim();
        if (!line || line === '[DONE]' || line === '"[DONE]"') continue;
        try {
            const obj = JSON.parse(line);
            if (obj && obj.type) abxHandleEvent(obj);
        } catch (e) { /* non-JSON frame — ignore */ }
    }
}

    // get_current_state / other JSON endpoints may embed event arrays
    function abxHandleJson(url, data) {
        try {
            __ABX.chunks++;
            if (!data || typeof data !== 'object') return;
            const found = [];
            const walk = (o, depth) => {
                if (!o || typeof o !== 'object' || depth > 6) return;
                if (Array.isArray(o)) {
                    o.forEach(x => walk(x, depth + 1));
                    return;
                }
if (typeof o.type === 'string' &&
    (o.type === 'text_delta' || o.type === 'text_stop' ||
     o.type === 'augment_with_inline_citation' ||
     o.type === 'augment_with_news' || o.type === 'augment_with_discussions' ||
     o.type === 'augment_with_videos' || o.type === 'augment_with_web' ||
     o.type === 'augment_with_places' || o.type === 'augment_with_products' ||
     o.type === 'tool_use' || o.type === 'rag' || o.type === 'final')) {
    found.push(o);
    return;
}
                Object.keys(o).forEach(k => walk(o[k], depth + 1));
            };
            walk(data, 0);
            found.forEach(abxHandleEvent);
            if (found.length === 0 && url.indexOf('get_current_state') !== -1) {
                console.debug('[ABX] get_current_state seen but no known events matched (shape changed?)');
            }
        } catch (e) { /* ignore */ }
    }

    // ---- fetch wrapper ----
    const origFetch = window.fetch.bind(window);
    window.fetch = function(input, init) {
        const url = (typeof input === 'string') ? input
                  : (input && input.url) || '';
        const lower = url.toLowerCase();
        const isStream = url.indexOf('/api/') !== -1 && lower.indexOf('stream') !== -1;
        const isState  = url.indexOf('get_current_state') !== -1 ||
                         url.indexOf('current_state') !== -1;
        const promise = arguments.length >= 2 ? origFetch(input, init) : origFetch(input);
        if (!isStream && !isState) return promise;

        return promise.then(function(res) {
            try {
                if (isStream && res.body && res.body.getReader) {
                    // MUST clone: reading res.body directly locks it for the page.
                    let clone = null;
                    try { clone = res.clone(); } catch (e) { clone = null; }
                    if (clone && clone.body) {
                        const reader = clone.body.getReader();
                        const decoder = new TextDecoder();
                        let buf = '';
                        const pump = () => reader.read().then(({ done, value }) => {
                            if (value) {
                                buf += decoder.decode(value, { stream: true });
// fetch wrapper — replace the two lines inside pump():
let idx;
while ((idx = buf.indexOf('\n')) !== -1) {
    abxParseSSE(buf.slice(0, idx));
    buf = buf.slice(idx + 1);
}
                            }
                            if (done) {
                                if (buf.trim()) abxParseSSE(buf);
                                return;
                            }
                            return pump();
                        }).catch(() => {});
                        pump();
                    }
                } else if (isState) {
                    res.clone().json().then(j => abxHandleJson(url, j)).catch(() => {});
                }
            } catch (e) { /* ignore */ }
            return res;
        });
    };

    // ---- XMLHttpRequest backup ----
    const OrigXHR = window.XMLHttpRequest;
    function PatchedXHR() {
        const xhr = new OrigXHR();
        let _url = '';
        const origOpen = xhr.open;
        xhr.open = function(m, u) {
            _url = u || '';
            return origOpen.apply(xhr, arguments);
        };
        xhr.addEventListener('load', function() {
            try {
                const lower = _url.toLowerCase();
                if (_url.indexOf('/api/') !== -1 && lower.indexOf('stream') !== -1 && xhr.responseText) {
                    abxParseSSE(xhr.responseText);
                } else if (_url.indexOf('get_current_state') !== -1 ||
                           _url.indexOf('current_state') !== -1) {
                    abxHandleJson(_url, JSON.parse(xhr.responseText));
                }
            } catch (e) { /* ignore */ }
        });
        return xhr;
    }
    PatchedXHR.prototype = OrigXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;

    // Read the conversation id from the URL (?conversation=...)
    function getCurrentConversationId() {
        try {
            const m = location.search.match(/[?&]conversation=([a-f0-9]+)/i);
            return m ? m[1] : null;
        } catch (e) { return null; }
    }

    // Convert captured API state into the conversation array used by generators.
    // Returns null when no usable data was captured (caller falls back to clipboard).
    function buildConversationFromApiState() {function buildConversationFromApiState() {
    const id = getCurrentConversationId();
    const conv = id ? __ABX.convs[id] : null;

    // --- Questions & answers from DOM (in document order) ---
    const domQs = Array.from(document.querySelectorAll('.message.user .user-bubble'))
        .map(e => (e.textContent || '').trim())
        .filter(t => t);

    const domAs = Array.from(document.querySelectorAll('.tap-round'))
        .map(e => {
            const clone = e.cloneNode(true);
            clone.querySelectorAll(
                '.tap-round-footer-actions, .tap-round-footer, button, [role="toolbar"]'
            ).forEach(el => el.remove());
            return (clone.textContent || '').trim();
        });

    // No questions in DOM at all → give up (nothing to base a conversation on).
    if (domQs.length === 0) return null;

    // --- Answers captured from the API during THIS page session ---
    const apiTurns = (conv && conv.turns)
        ? conv.turns.filter(t => typeof t.answerMd === 'string' && t.answerMd.trim() !== '')
        : [];
    const apiAnswers = apiTurns.map(t => ({
        answerMd:      t.answerMd.trim(),
        citations:     Object.values(t.citationsById || {}),
        augmentations: t.augmentations || [],
        ragUrls:       t.ragUrls      || []
    }));

    // API answers always cover the LAST N turns streamed after page load.
    // So DOM turn i uses apiAnswers[i - offset] when i - offset >= 0.
    const offset = domQs.length - apiAnswers.length;

    const conversation   = [];
    const sourcesByTurn  = [];

    for (let i = 0; i < domQs.length; i++) {
        const apiIdx = i - offset;
        let answerText = '';
        let src = null;

        if (apiIdx >= 0 && apiIdx < apiAnswers.length) {
            answerText = apiAnswers[apiIdx].answerMd;
            src        = apiAnswers[apiIdx];
        } else if (domAs[i]) {
            answerText = domAs[i];
        }

        conversation.push({ type: 'user', content: domQs[i], index: i + 1 });
        if (answerText) {
            conversation.push({ type: 'assistant', content: answerText, index: i + 1 });
        }

        if (src) {
            sourcesByTurn.push({
                index:         i + 1,
                citations:     src.citations,
                augmentations: src.augmentations,
                ragUrls:       src.ragUrls
            });
        }
    }

    if (conversation.length === 0) return null;
    if (sourcesByTurn.length) conversation.sourcesByTurn = sourcesByTurn;
    return conversation;
}

    // =============================================
    // MAIN EXPORT BUTTON
    // =============================================
    function createExportButton() {
        const btn = document.createElement('button');
        btn.innerHTML = '💾 Export';
        btn.id = 'brave-export-btn';
        btn.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 99999;
            padding: 12px 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            transition: all 0.3s ease;
        `;

        btn.addEventListener('mouseover', function() {
            this.style.transform = 'translateY(-2px)';
        });

        btn.addEventListener('mouseout', function() {
            this.style.transform = 'translateY(0)';
        });

        btn.onclick = showExportDialog;
        document.body.appendChild(btn);
    }

    // =============================================
    // EXPORT DIALOG
    // =============================================
    function showExportDialog() {
        const firstUserMsg = document.querySelector('.message.user .user-bubble');

        // API-mode title fallback
        let apiFirstQuestion = null;
        try {
            const __cid = getCurrentConversationId();
            const __conv = __cid && __ABX.convs[__cid];
            if (__conv && __conv.turns.length) {
                for (let i = 0; i < __conv.turns.length; i++) {
                    const q = __conv.turns[i].question;
                    if (typeof q === 'string' && q.trim()) { apiFirstQuestion = q.trim(); break; }
                }
            }
        } catch (e) { /* ignore */ }

        const defaultTitle = truncateTitle(
            (firstUserMsg ? firstUserMsg.textContent.trim() : '') ||
            apiFirstQuestion || 'Brave Ask Conversation',
            CONFIG.MAX_TITLE_LENGTH);

        // Data-source status line for the dialog
        let sourceStatus;
        const cid = getCurrentConversationId();
        const convData = cid ? __ABX.convs[cid] : null;
        if (CONFIG.EXPORT_MODE === 'clipboard') {
            sourceStatus = '📋 Mode: clipboard (manual)';
        } else if (convData && convData.turns && convData.turns.length > 0) {
            sourceStatus = '✅ API data ready (' + convData.turns.length + ' turns captured) — no clipboard needed';
        } else {
            sourceStatus = '⚠️ No API data captured yet for this conversation — will use clipboard-write capture (fallback).';
        }

        const dialog = document.createElement('div');
        dialog.id = 'brave-export-dialog';
        dialog.className = 'export-dialog-wrapper';
        dialog.innerHTML = `
    <div class="export-dialog-content">
        <h2>Export Conversation</h2>

        <div style="margin-bottom: 15px; font-size: 13px; color: var(--text-secondary, #888);">${sourceStatus}</div>

        <div style="margin-bottom: 25px;">
            <label class="export-dialog-label">Title</label>
            <input type="text"
                   id="export-title"
                   class="export-dialog-input"
                   value=""
                   placeholder="${defaultTitle}">
        </div>

        <div style="margin-bottom: 25px;">
            <label class="export-dialog-label">Export formats</label>
            <div class="export-dialog-checkboxes">
                <label class="export-dialog-checkbox-label">
                    <input type="checkbox" id="export-markdown" checked>
                    <span>Markdown</span>
                </label>
                <label class="export-dialog-checkbox-label">
                    <input type="checkbox" id="export-html" checked>
                    <span>HTML</span>
                </label>
            </div>
            <div style="margin-top: 12px;">
                <span style="font-size: 13px; color: var(--text-secondary);">Need something? </span>
                <a href="https://github.com/abdo2048/Ask-Brave-Chat-Exporter"
                   target="_blank"
                   class="export-dialog-link">Visit GitHub repo</a>
            </div>
        </div>

        <div class="export-dialog-buttons">
            <button id="export-cancel-btn" class="export-dialog-btn export-dialog-btn-cancel">Cancel</button>
            <button id="export-download-btn" class="export-dialog-btn export-dialog-btn-download">Download</button>
        </div>
    </div>
`;

        document.body.appendChild(dialog);

        document.getElementById('export-cancel-btn').onclick = function() {
            if (dialog._enterKeyHandler) {
                document.removeEventListener('keydown', dialog._enterKeyHandler);
            }
            dialog.remove();
        };

        document.getElementById('export-download-btn').onclick = function() {
            const titleInput = document.getElementById('export-title').value.trim();
            const title = titleInput || defaultTitle;
            const exportMd = document.getElementById('export-markdown').checked;
            const exportHtml = document.getElementById('export-html').checked;

            if (!exportMd && !exportHtml) {
                alert('Please select at least one export format.');
                return;
            }

            if (dialog._enterKeyHandler) {
                document.removeEventListener('keydown', dialog._enterKeyHandler);
            }
            dialog.remove();
            startExport(title, exportMd, exportHtml);
        };

        // Enter key support
        const handleEnterKey = function(e) {
            const dlg = document.getElementById('brave-export-dialog');
            if (e.key === 'Enter' && dlg) {
                e.preventDefault();
                const downloadBtn = document.getElementById('export-download-btn');
                if (downloadBtn) downloadBtn.click();
            }
        };
        document.addEventListener('keydown', handleEnterKey);
        dialog._enterKeyHandler = handleEnterKey;

        document.getElementById('export-title').focus();
    }

    // =============================================
    // EXPORT PROCESS
    // =============================================
    async function startExport(title, exportMd, exportHtml) {
        showOverlay();

        try {
            let conversation = null;
            let usedMode = 'api';

            const mode = CONFIG.EXPORT_MODE || 'auto';
            if (mode === 'api' || mode === 'auto') {
                updateOverlay('Reading captured conversation data...');
                conversation = buildConversationFromApiState();
                if (!conversation && mode === 'auto') {
                    console.warn('[ABX] No API state captured for this conversation; falling back to clipboard-write capture.');
                }
            }

            if (!conversation) {
                usedMode = 'clipboard';
                updateOverlay('Capturing user messages...');
                const userMessages = await copyUserMessages();
                console.log('User messages captured:', userMessages.length);

                updateOverlay('Capturing AI answers...');
                const aiAnswers = await copyAIAnswers();
                console.log('AI answers captured:', aiAnswers.length);

                updateOverlay('Building conversation...');
                conversation = buildConversation(userMessages, aiAnswers);
            }

            console.log('[ABX] Export using mode:', usedMode, '| messages:', conversation.length);

            if (exportMd) {
                updateOverlay('Generating Markdown...');
                const markdown = generateMarkdown(title, conversation, usedMode);
                downloadFile(markdown, sanitizeFilename(title) + '.md', 'text/markdown');
            }

            if (exportHtml) {
                updateOverlay('Generating HTML...');
                const html = generateHTML(title, conversation, usedMode);
                if (html) {
                    downloadFile(html, sanitizeFilename(title) + '.html', 'text/html');
                }
            }

            updateOverlay('Export complete! ✓');
            await sleep(1000);
            hideOverlay();

        } catch (error) {
            console.error('Export failed:', error);
            alert('Export failed. Check console for details.');
            hideOverlay();
        }
    }

    // =============================================
    // COPY OPERATIONS (clipboard-WRITE capture)
    // =============================================
    // Click a copy button and capture what the page writes to the clipboard.
    // Returns null if no write is observed within `timeoutMs`.
    async function clickAndCapture(button, timeoutMs) {
        if (!button) return null;
        if (timeoutMs === undefined) timeoutMs = 800;

        __ABX_CLIP.text = null;
        const before = __ABX_CLIP.at;

        try { button.click(); } catch (e) { return null; }

        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (__ABX_CLIP.text !== null && __ABX_CLIP.at >= before) {
                return __ABX_CLIP.text;
            }
            await sleep(30);
        }
        return null;
    }

    async function copyUserMessages() {
        const messages = [];
        const userMsgContainers = document.querySelectorAll('.message.user');

        for (let i = 0; i < userMsgContainers.length; i++) {
            const container = userMsgContainers[i];
            const copyBtn = container.querySelector(
                '.user-message-actions button[aria-label="Copy"]');

            let text = await clickAndCapture(copyBtn);
            if (text === null) {
                // DOM fallback — the raw question is plainly visible
                const bubble = container.querySelector('.user-bubble') || container;
                text = (bubble.textContent || '').trim();
                if (text) console.warn('[ABX] clipboard write not detected for user msg', i + 1, '- using DOM text');
            }
            if (text) messages.push(text.trim());
        }

        return messages;
    }

    async function copyAIAnswers() {
        const answers = [];
        const answerContainers = document.querySelectorAll('.tap-round');

        console.log('Found AI answer containers:', answerContainers.length);

        for (let i = 0; i < answerContainers.length; i++) {
            const container = answerContainers[i];
            const copyBtn = container.querySelector(
                '.tap-round-footer-actions button.tap-round-footer-action[aria-label="Copy"]');

            let text = await clickAndCapture(copyBtn);

            if (text === null) {
                // DOM fallback: strip UI chrome before grabbing text.
                const clone = container.cloneNode(true);
                clone.querySelectorAll(
                    '.tap-round-footer-actions, .tap-round-footer, button, [role="toolbar"]'
                ).forEach(el => el.remove());
                text = (clone.textContent || '').trim();
                if (text) console.warn('[ABX] clipboard write not detected for answer', i + 1, '- using DOM text');
            }

            if (text) answers.push(text.trim());
            else console.warn('No answer text captured for container', i + 1);
        }

        console.log('Total answers captured:', answers.length);
        return answers;
    }

    // =============================================
    // BUILD CONVERSATION
    // =============================================
    function buildConversation(userMessages, aiAnswers) {
        const conversation = [];

        for (let i = 0; i < Math.max(userMessages.length, aiAnswers.length); i++) {
            if (userMessages[i]) {
                conversation.push({
                    type: 'user',
                    content: userMessages[i],
                    index: i + 1
                });
            }
            if (aiAnswers[i]) {
                conversation.push({
                    type: 'assistant',
                    content: aiAnswers[i],
                    index: i + 1
                });
            }
        }

        return conversation;
    }

    // =============================================
    // MARKDOWN GENERATION
    // =============================================
    function generateMarkdown(title, conversation, usedMode) {
        const now = new Date();
        const dateStr = formatDate(now);

        let md = '';

        md += '---\n';
        md += '**Title:** ' + title + '\n';
        md += '**Exported:** ' + dateStr + '\n';
        if (usedMode === 'api') {
            md += '**Method:** API capture (no clipboard)\n';
        } else if (usedMode === 'clipboard') {
            md += '**Method:** Clipboard write capture\n';
        }
        md += '\n---\n';

        let currentQ = 0;

        for (let idx = 0; idx < conversation.length; idx++) {
            const msg = conversation[idx];

            if (msg.type === 'user') {
                currentQ++;
                md += '◤━━━━━━ Q' + currentQ + ' ━━━━━◥\n';
                md += msg.content + '\n';
                md += '◣━━━━━━ Q' + currentQ + ' ━━━━━◢\n\n';
            } else {
                md += msg.content + '\n\n';
                if (idx < conversation.length - 1) {
                    md += '---\n\n';
                }
            }
        }

        return md;
    }

    // =============================================
    // HTML GENERATION
    // =============================================
    function generateHTML(title, conversation, usedMode) {
        const now = new Date();
        const dateStr = formatDate(now);
        const methodNote = usedMode === 'api' ? ' · API capture' : (usedMode === 'clipboard' ? ' · clipboard' : '');

        if (typeof marked === 'undefined') {
            console.error('marked.js library not loaded!');
            alert('HTML export failed: marked.js library not loaded.');
            return '';
        }

        // Configure marked to add IDs to headings
        const renderer = {
            heading({ tokens, depth }) {
                const text = this.parser.parseInline(tokens);
                const escapedText = text.toLowerCase().replace(/[^\w]+/g, '-');
                return `<h${depth} id="${escapedText}">${text}</h${depth}>`;
            }
        };
        marked.use({ renderer });

        let contentHTML = '';
        let currentQ = 0;

        for (let i = 0; i < conversation.length; i++) {
            const msg = conversation[i];

            if (msg.type === 'user') {
                currentQ++;

                if (currentQ > 1) {
                    contentHTML += '<div class="separator">───────</div>\n';
                }

                contentHTML += '<div id="Q' + currentQ + '" class="question">\n';
                contentHTML += '<blockquote><strong>Q' + currentQ + ':</strong><br>\n';
                contentHTML += '<pre class="question-text">' + escapeHtml(msg.content) + '</pre>\n';
                contentHTML += '</blockquote>\n';
                contentHTML += '</div>\n';

            } else {
                contentHTML += '<div class="answer">\n';
                contentHTML += marked.parse(msg.content);
                contentHTML += '</div>\n';
            }
        }

        const tocHTML = generateTOCHTML(conversation);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <link rel="preconnect" href="https://rsms.me/">
    <link rel="stylesheet" href="https://rsms.me/inter/inter.css">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5/index.css">
    <style>
:root {
  --bg-body: #f8fafc;
  --bg-surface: #ffffff;
  --bg-sidebar: #ffffff;
  --bg-blockquote-q: #f1f5f9;
  --bg-blockquote-note: #f8fafc;
  --border-note: #cbd5e1;
  --bg-code-block: #1e293b;
  --bg-code-inline: #e2e8f0;
  --text-code-block: #e2e8f0;
  --text-code-inline: #0f172a;
  --text-primary: #0f172a;
  --text-secondary: #475569;
  --primary: #4f46e5;
  --primary-hover: #4338ca;
  --accent: #0ea5e9;
  --border-color: #e2e8f0;
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.1);
  --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.1);
  --shadow-float: 0 10px 15px -3px rgba(0,0,0,0.1);
  --font-base: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  --text-scale-base: clamp(1rem, 1vw + 0.8rem, 1.125rem);
  --text-scale-h1: clamp(1.8rem, 3.5vw + 0.9rem, 2.7rem);
  --text-scale-h2: clamp(1.35rem, 2.7vw + 0.9rem, 2rem);
  --text-scale-h3: clamp(1.1rem, 1.8vw + 0.9rem, 1.55rem);
  --sidebar-width: 300px;
  --container-max: 1000px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-body: #0f172a;
    --bg-surface: #1e293b;
    --bg-sidebar: #1e293b;
    --bg-code-inline: #334155;
    --text-code-inline: #e2e8f0;
    --bg-code-block: #0B111F;
    --text-code-block: #f8fafc;
    --bg-blockquote-q: #334155;
    --bg-blockquote-note: #334155;
    --border-note: #475569;
    --text-primary: #f1f5f9;
    --text-secondary: #cbd5e1;
    --primary: #818cf8;
    --primary-hover: #6366f1;
    --border-color: #334155;
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.5);
    --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.5);
  }
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; font-size: 16px; }
body {
  font-family: var(--font-base);
  background-color: var(--bg-body);
  color: var(--text-primary);
  line-height: 1.7;
  font-size: var(--text-scale-base);
  overflow-x: hidden;
}
:focus-visible { outline: 2px solid var(--primary); outline-offset: 4px; }
@media (prefers-reduced-motion: reduce) {
  html, body, * { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
}

.container {
  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr;
  min-height: 100vh;
  transition: grid-template-columns var(--transition);
}

.toc-sidebar {
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-color);
  height: 100vh;
  position: sticky;
  top: 0;
  padding: 2rem;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--text-secondary) transparent;
}
.toc-sidebar h2 {
  font-size: 1.25rem;
  margin-bottom: 1.5rem;
  color: var(--primary);
  letter-spacing: -0.02em;
}
.toc-sidebar ul {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.toc-sidebar a {
  display: block;
  text-decoration: none;
  color: var(--text-secondary);
  font-size: 0.95rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-md);
  transition: all var(--transition);
  border-left: 3px solid transparent;
}
.toc-sidebar a:hover {
  background: var(--bg-body);
  color: var(--primary);
  transform: translateX(4px);
}
.toc-sidebar a.active {
  background: var(--bg-blockquote-q);
  color: var(--primary);
  border-left-color: var(--primary);
  font-weight: 600;
}
.toc-q { font-weight: 700; margin-top: 1rem; }
.toc-h2 { padding-left: 1rem; font-size: 0.9rem; }

.main-content {
  padding: 3rem 4rem;
  width: 100%;
  max-width: var(--container-max);
  margin: 0 auto;
}
.header {
  background: var(--bg-surface);
  padding: 3rem;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  margin-bottom: 2rem;
  border: 1px solid var(--border-color);
  text-align: center;
}
.header h1 {
  font-size: var(--text-scale-h1);
  line-height: 1.2;
  margin-bottom: 1rem;
  color: var(--primary);
  background: linear-gradient(135deg, var(--primary), var(--accent));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
.header .meta {
  color: var(--text-secondary);
  font-size: 0.9rem;
  font-family: var(--font-mono);
  opacity: 0.8;
}
.content {
  background: var(--bg-surface);
  padding: 4rem;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  border: 1px solid var(--border-color);
}

h2 {
  font-size: var(--text-scale-h2);
  margin: 2.5rem 0 1.5rem;
  color: var(--text-primary);
  padding-bottom: 0.5rem;
  border-bottom: 2px solid var(--border-color);
}
h3 {
  font-size: var(--text-scale-h3);
  margin: 2rem 0 1rem;
  color: var(--text-secondary);
}
p { margin-bottom: 1.5rem; }

.code-wrapper { position: relative; margin: 2rem 0; }
pre {
  background: var(--bg-code-block);
  color: var(--text-code-block);
  padding: 1.5rem;
  border-radius: var(--radius-md);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.9rem;
}
pre code { background: none; padding: 0; font-family: inherit; }

:not(pre) > code {
  background-color: var(--bg-code-inline);
  color: var(--text-code-inline);
  padding: 0.2em 0.4em;
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 0.85em;
  border: 1px solid transparent;
}

.table-wrapper {
  position: relative;
  margin: 2rem 0;
  overflow-x: auto;
  border-radius: var(--radius-md);
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
}
thead { background: var(--primary); color: white; }
thead th {
  padding: 0.875rem 1rem;
  text-align: left;
  font-weight: 600;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
tbody tr {
  border-bottom: 1px solid var(--border-color);
  transition: background-color 0.2s ease;
}
tbody tr:nth-child(odd) { background: var(--bg-surface); }
tbody tr:nth-child(even) { background: var(--bg-body); }
tbody tr:hover { background: var(--bg-blockquote-q); }
tbody td { padding: 0.75rem 1rem; text-align: left; color: var(--text-primary); }
tbody td:first-child { font-weight: 600; color: var(--text-primary); }

@media (max-width: 768px) {
  .table-wrapper { border-radius: var(--radius-md); }
  table { font-size: 0.8rem; }
  thead th { padding: 0.625rem 0.75rem; font-size: 0.75rem; }
  tbody td { padding: 0.625rem 0.75rem; }
}
@media (prefers-color-scheme: dark) {
  thead { background: var(--primary-hover); }
  tbody tr:hover { background: rgba(255,255,255,0.05); }
  :not(pre) > code { border-color: rgba(255,255,255,0.1); }
}

.copy-btn {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  background: rgba(255,255,255,0.1);
  border: 1px solid rgba(255,255,255,0.2);
  color: var(--text-code-block);
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.8rem;
  transition: var(--transition);
  opacity: 0;
}
.code-wrapper:hover .copy-btn,
.question:hover .copy-btn,
.table-wrapper:hover .copy-btn { opacity: 1; }
.copy-btn:hover {
  background: var(--primary);
  border-color: var(--primary);
  color: white;
}

.table-menu-btn {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 16px;
  color: var(--text-secondary);
  transition: var(--transition);
  z-index: 10;
  padding: 0;
}
.table-menu-btn:hover {
  background: var(--bg-blockquote-q);
  border-color: var(--primary);
  color: var(--primary);
}
.table-menu-btn:focus { outline: 2px solid var(--primary); outline-offset: 2px; }

.table-dropdown {
  position: absolute;
  top: 2.75rem;
  right: 0.75rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  min-width: 180px;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-8px);
  transition: opacity 0.2s ease, transform 0.2s ease, visibility 0.2s;
  z-index: 100;
  overflow: hidden;
}
.table-dropdown.active { opacity: 1; visibility: visible; transform: translateY(0); }
.table-dropdown-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--text-primary);
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  transition: background 0.15s ease;
}
.table-dropdown-item:hover { background: var(--bg-blockquote-q); }
.table-dropdown-item:active { background: var(--bg-blockquote-note); }
.table-dropdown-item:focus { outline: 2px solid var(--primary); outline-offset: -2px; }
.table-dropdown-item span { font-size: 16px; }
.table-dropdown-separator { height: 1px; background: var(--border-color); margin: 0.25rem 0; }
@media (prefers-color-scheme: dark) {
  .table-menu-btn { background: var(--bg-body); }
  .table-dropdown { box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
}

blockquote {
  background: var(--bg-blockquote-note);
  border-left: 4px solid var(--border-note);
  padding: 1rem 1.5rem;
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  margin: 1.5rem 0;
  font-style: italic;
  color: var(--text-secondary);
}
.question { position: relative; margin: 3rem 0 1.5rem; }
.question blockquote {
  background: var(--bg-blockquote-q);
  border-left: 6px solid var(--primary);
  padding: 1.25rem 2rem;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  font-style: normal;
  color: var(--text-primary);
}
.question strong {
  display: block;
  color: var(--primary);
  font-size: 1.1rem;
  margin-bottom: 0.25rem;
  line-height: 1.2;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.question .copy-btn {
  top: 1rem;
  right: 1rem;
  background: var(--bg-surface);
  color: var(--text-secondary);
  border-color: var(--border-color);
}
.question pre.question-text {
  font-family: var(--font-base);
  white-space: pre-wrap;
  font-size: var(--text-scale-h3);
  font-weight: 700;
  color: var(--text-primary);
  background: none;
  padding: 0;
  border: none;
  margin: 0;
  border-radius: 0;
}
.separator { display: none; }

@media (max-width: 1024px) {
  .container { grid-template-columns: 1fr; }
  .toc-sidebar {
    position: fixed;
    top: 0; left: 0;
    width: 280px; z-index: 1000;
    transform: translateX(-100%);
    transition: transform var(--transition);
    box-shadow: var(--shadow-float);
  }
  .toc-sidebar.open { transform: translateX(0); }
  .main-content { padding: 1.5rem; }
  .header, .content { padding: 1.5rem; }

  .mobile-menu-btn {
    display: flex !important;
    position: fixed;
    bottom: 20px; right: 20px;
    background: var(--primary);
    color: white;
    width: 50px; height: 50px;
    border-radius: 50%;
    align-items: center; justify-content: center;
    box-shadow: var(--shadow-float);
    z-index: 1100;
    cursor: pointer;
    border: none;
    font-size: 1.5rem;
  }

  .overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 999;
    opacity: 0; pointer-events: none;
    transition: opacity var(--transition);
  }
  .overlay.active { opacity: 1; pointer-events: auto; }
}
.mobile-menu-btn { display: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="toc-sidebar">
            <h2>📑 Contents</h2>
            ${tocHTML}
        </div>
        <div class="main-content">
            <div class="header">
                <h1>${escapeHtml(title)}</h1>
                <div class="meta">Exported: ${dateStr}${methodNote}</div>
            </div>
            <div class="content">
                ${contentHTML}
            </div>
        </div>
    </div>

    <script>
document.addEventListener('DOMContentLoaded', () => {
    const body = document.body;

    const btn = document.createElement('button');
    btn.className = 'mobile-menu-btn';
    btn.innerHTML = '☰';
    btn.ariaLabel = 'Toggle Table of Contents';

    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    body.appendChild(btn);
    body.appendChild(overlay);

    const sidebar = document.querySelector('.toc-sidebar');

    function toggleMenu() {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('active');
        btn.innerHTML = sidebar.classList.contains('open') ? '✕' : '☰';
    }

    btn.addEventListener('click', toggleMenu);
    overlay.addEventListener('click', toggleMenu);

    sidebar.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            if (window.innerWidth < 1024) toggleMenu();
        });
    });

    const tocLinks = document.querySelectorAll('.toc-sidebar a');
    const sections = Array.from(tocLinks).map(link => {
        const id = link.getAttribute('href').replace('#', '');
        return document.getElementById(id);
    }).filter(el => el);

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                tocLinks.forEach(link => link.classList.remove('active'));
                const activeLink = document.querySelector('.toc-sidebar a[href="#' + entry.target.id + '"]');
                if (activeLink) {
                    activeLink.classList.add('active');
                    activeLink.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
        });
    }, { rootMargin: '-20% 0px -70% 0px' });

    sections.forEach(section => observer.observe(section));

    document.querySelectorAll('pre').forEach(pre => {
        if (pre.classList.contains('question-text')) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'code-wrapper';
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);
        addCopyButton(wrapper, pre.innerText);
    });

    document.querySelectorAll('.question').forEach(q => {
        const text = q.querySelector('.question-text')?.innerText || q.innerText;
        addCopyButton(q, text);
    });

    document.querySelectorAll('table').forEach(table => {
        const wrapper = document.createElement('div');
        wrapper.className = 'table-wrapper';
        table.parentNode.insertBefore(wrapper, table);
        wrapper.appendChild(table);
        addTableMenu(wrapper, table);
    });

    function addTableMenu(wrapper, table) {
        const menuBtn = document.createElement('button');
        menuBtn.className = 'table-menu-btn';
        menuBtn.innerHTML = '⋮';
        menuBtn.setAttribute('aria-label', 'Table options');
        menuBtn.setAttribute('aria-expanded', 'false');
        menuBtn.setAttribute('aria-haspopup', 'true');

        const dropdown = document.createElement('div');
        dropdown.className = 'table-dropdown';
        dropdown.setAttribute('role', 'menu');

        const plainText = extractTableAsPlainText(table);
        const csvText = extractTableAsTSV(table);
        const markdownText = extractTableAsMarkdown(table);

        const items = [
            { icon: '📊', text: 'Copy for Excel', action: () => copyToClipboard(csvText) },
            { icon: '📋', text: 'Copy as Text', action: () => copyToClipboard(plainText) },
            { separator: true },
            { icon: '📝', text: 'Copy Markdown', action: () => copyToClipboard(markdownText) }
        ];

        items.forEach((item) => {
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'table-dropdown-separator';
                dropdown.appendChild(sep);
            } else {
                const menuItem = document.createElement('button');
                menuItem.className = 'table-dropdown-item';
                menuItem.setAttribute('role', 'menuitem');
                menuItem.setAttribute('tabindex', '-1');
                menuItem.innerHTML = '<span>' + item.icon + '</span>' + item.text;
                menuItem.addEventListener('click', (e) => {
                    e.stopPropagation();
                    item.action();
                    closeDropdown();
                });
                dropdown.appendChild(menuItem);
            }
        });

        function toggleDropdown(e) {
            e.stopPropagation();
            const isActive = dropdown.classList.contains('active');
            document.querySelectorAll('.table-dropdown.active').forEach(d => d.classList.remove('active'));
            if (!isActive) {
                dropdown.classList.add('active');
                menuBtn.setAttribute('aria-expanded', 'true');
                const firstItem = dropdown.querySelector('.table-dropdown-item');
                if (firstItem) firstItem.setAttribute('tabindex', '0');
            } else {
                closeDropdown();
            }
        }

        function closeDropdown() {
            dropdown.classList.remove('active');
            menuBtn.setAttribute('aria-expanded', 'false');
            dropdown.querySelectorAll('.table-dropdown-item').forEach(item => {
                item.setAttribute('tabindex', '-1');
            });
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                const originalText = menuBtn.innerHTML;
                menuBtn.innerHTML = '✓';
                menuBtn.style.color = 'var(--primary)';
                setTimeout(() => {
                    menuBtn.innerHTML = originalText;
                    menuBtn.style.color = '';
                }, 1500);
            }).catch(err => console.error('Failed to copy:', err));
        }

        menuBtn.addEventListener('click', toggleDropdown);

        document.addEventListener('click', (e) => {
            if (!wrapper.contains(e.target)) closeDropdown();
        });

        dropdown.addEventListener('keydown', (e) => {
            const items = Array.from(dropdown.querySelectorAll('.table-dropdown-item'));
            const currentIndex = items.findIndex(item => item === document.activeElement);
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                items[(currentIndex + 1) % items.length].focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                items[currentIndex <= 0 ? items.length - 1 : currentIndex - 1].focus();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeDropdown();
                menuBtn.focus();
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (document.activeElement.classList.contains('table-dropdown-item')) {
                    document.activeElement.click();
                }
            }
        });

        wrapper.appendChild(menuBtn);
        wrapper.appendChild(dropdown);
    }

    function extractTableAsPlainText(table) {
        let text = '';
        const NL = String.fromCharCode(10);
        const headers = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim());
        if (headers.length > 0) {
            text += headers.join('  ') + NL;
            text += headers.map(() => '---').join('  ') + NL;
        }
        table.querySelectorAll('tbody tr').forEach(row => {
            const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
            text += cells.join('  ') + NL;
        });
        return text;
    }

    function addCopyButton(parent, textToCopy) {
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.innerText = 'Copy';
        btn.addEventListener('click', () => {
            navigator.clipboard.writeText(textToCopy).then(() => {
                btn.innerText = 'Copied!';
                setTimeout(() => btn.innerText = 'Copy', 2000);
            });
        });
        parent.appendChild(btn);
    }

    function extractTableAsMarkdown(table) {
        let markdown = '';
        const NL = String.fromCharCode(10);
        const headers = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim());
        if (headers.length > 0) {
            markdown += '| ' + headers.join(' | ') + ' |' + NL;
            markdown += '|' + headers.map(() => '---').join('|') + '|' + NL;
        }
        table.querySelectorAll('tbody tr').forEach(row => {
            const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
            markdown += '| ' + cells.join(' | ') + ' |' + NL;
        });
        return markdown;
    }

    function extractTableAsTSV(table) {
        let tsv = '';
        const TAB = String.fromCharCode(9);
        const NL = String.fromCharCode(10);
        const headers = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim());
        if (headers.length > 0) {
            tsv += headers.join(TAB) + NL;
        }
        table.querySelectorAll('tbody tr').forEach(row => {
            const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
            tsv += cells.join(TAB) + NL;
        });
        return tsv;
    }
});
    </script>
</body>
</html>`;
    }

    function generateTOCHTML(conversation) {
        let html = '<ul>\n';
        let currentQ = 0;

        const userMsgs = conversation.filter(function(msg) {
            return msg.type === 'user';
        });

        for (let i = 0; i < userMsgs.length; i++) {
            const msg = userMsgs[i];
            currentQ++;

            const truncated = truncateTitle(msg.content, 60);
            html += '<li><a href="#Q' + currentQ + '" class="toc-q">Q' + currentQ + ': ' + escapeHtml(truncated) + '</a></li>\n';

            const msgIdx = conversation.indexOf(msg);
            let nextAnswer = null;
            for (let k = msgIdx + 1; k < conversation.length; k++) {
                if (conversation[k].type === 'assistant') { nextAnswer = conversation[k]; break; }
            }

            if (nextAnswer) {
                const headers = extractH2Headers(nextAnswer.content);
                for (let j = 0; j < headers.length; j++) {
                    const headerId = slugify(headers[j]);
                    html += '<li><a href="#' + headerId + '" class="toc-h2">' + escapeHtml(headers[j]) + '</a></li>\n';
                }
            }
        }

        html += '</ul>';
        return html;
    }

    function extractH2Headers(markdown) {
        const headers = [];
        const lines = markdown.split('\n');
        let inCodeBlock = false;

        for (let i = 0; i < lines.length; i++) {
            const trimmedLine = lines[i].trim();

            if (trimmedLine.startsWith('```')) {
                inCodeBlock = !inCodeBlock;
                continue;
            }
            if (inCodeBlock) continue;
            if (trimmedLine.startsWith('>')) continue;

            if (trimmedLine.startsWith('## ')) {
                headers.push(trimmedLine.replace('## ', '').trim());
            }
        }

        return headers;
    }

    function slugify(text) {
        return text
            .toLowerCase()
            .trim()
            .replace(/[^\w\s-]/g, '')
            .replace(/[\s_-]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    // =============================================
    // OVERLAY
    // =============================================
    function showOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'brave-export-overlay';
        overlay.innerHTML = `
            <div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.85); z-index: 999999; display: flex; align-items: center; justify-content: center;">
                <div style="text-align: center; color: white;">
                    <div style="font-size: 60px; margin-bottom: 40px;">⏳</div>
                    <div id="overlay-message" style="font-size: 24px; font-weight: 600;">Processing...</div>
                    <div style="font-size: 14px; margin-top: 12px; opacity: 0.7;">Please do not interact with the page</div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        return overlay;
    }

    function updateOverlay(message) {
        const msgEl = document.getElementById('overlay-message');
        if (msgEl) msgEl.textContent = message;
    }

    function hideOverlay() {
        const overlay = document.getElementById('brave-export-overlay');
        if (overlay) overlay.remove();
    }

    // =============================================
    // UTILITIES
    // =============================================
    function sleep(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    function truncateTitle(text, maxLength) {
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength).trim() + '...';
    }

    function sanitizeFilename(filename) {
        return filename.replace(/[?<>:*|"]/g, '').substring(0, 200);
    }

    function formatDate(date) {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

        const dayName = days[date.getDay()];
        const day = String(date.getDate()).padStart(2, '0');
        const month = months[date.getMonth()];
        const year = date.getFullYear();

        let hours = date.getHours();
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;

        return dayName + ' ' + day + '-' + month + '-' + year + ' , ' + String(hours).padStart(2, '0') + ':' + minutes + ' ' + ampm;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // =============================================
    // DIALOG CSS (injected into the *Brave page*)
    // =============================================
    function injectDialogCSS() {
        const style = document.createElement('style');
        style.textContent = `
.export-dialog-wrapper {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999999;
  backdrop-filter: blur(4px);
}
.export-dialog-content {
  background: #ffffff;
  padding: 30px;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  max-width: 500px;
  width: 90%;
  border: 1px solid #e2e8f0;
}
.export-dialog-content h2 {
  margin: 0 0 25px 0;
  font-size: 24px;
  color: #0f172a;
  border-bottom: 2px solid #e2e8f0;
  padding-bottom: 15px;
}
.export-dialog-label {
  display: block;
  margin-bottom: 10px;
  font-weight: 600;
  color: #0f172a;
  font-size: 14px;
}
.export-dialog-input {
  width: 100%;
  padding: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 14px;
  font-family: Inter, system-ui, sans-serif;
  background: #f8fafc;
  color: #0f172a;
  transition: border-color 0.2s ease;
  box-sizing: border-box;
}
.export-dialog-input:focus {
  outline: none;
  border-color: #4f46e5;
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.1);
}
.export-dialog-checkboxes {
  display: flex;
  gap: 20px;
  margin-top: 10px;
}
.export-dialog-checkbox-label {
  display: flex;
  align-items: center;
  cursor: pointer;
  color: #0f172a;
  font-size: 14px;
}
.export-dialog-checkbox-label input[type="checkbox"] {
  margin-right: 8px;
  width: 18px;
  height: 18px;
  cursor: pointer;
  accent-color: #4f46e5;
}
.export-dialog-link {
  color: #4f46e5;
  text-decoration: none;
  font-weight: 600;
  font-size: 13px;
  transition: color 0.2s ease;
}
.export-dialog-link:hover {
  color: #4338ca;
  text-decoration: underline;
}
.export-dialog-buttons {
  display: flex;
  gap: 15px;
  justify-content: flex-end;
  margin-top: 30px;
}
.export-dialog-btn {
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
  font-family: Inter, system-ui, sans-serif;
}
.export-dialog-btn-cancel {
  background: #f8fafc;
  color: #475569;
  border: 1px solid #e2e8f0;
}
.export-dialog-btn-cancel:hover {
  background: #f1f5f9;
  color: #0f172a;
}
.export-dialog-btn-download {
  background: #4f46e5;
  color: white;
}
.export-dialog-btn-download:hover {
  background: #4338ca;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);
}
@media (prefers-color-scheme: dark) {
  .export-dialog-wrapper { background: rgba(0, 0, 0, 0.85); }
  .export-dialog-content {
    background: #1e293b;
    border-color: #334155;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  }
  .export-dialog-content h2 { color: #f1f5f9; border-bottom-color: #334155; }
  .export-dialog-label { color: #f1f5f9; }
  .export-dialog-input { background: #0f172a; color: #f1f5f9; border-color: #334155; }
  .export-dialog-checkbox-label { color: #f1f5f9; }
  .export-dialog-link { color: #818cf8; }
  .export-dialog-link:hover { color: #6366f1; }
  .export-dialog-btn-cancel {
    background: #0f172a;
    color: #cbd5e1;
    border-color: #334155;
  }
  .export-dialog-btn-cancel:hover { background: #334155; color: #f1f5f9; }
  .export-dialog-btn-download { background: #818cf8; }
  .export-dialog-btn-download:hover { background: #6366f1; }
}
    `;
        document.head.appendChild(style);
    }

    // =============================================
    // INITIALIZE
    // =============================================
    function init() {
        injectDialogCSS();

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', createExportButton);
        } else {
            createExportButton();
        }
    }

    init();

})();