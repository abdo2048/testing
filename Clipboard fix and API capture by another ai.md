## Two bugs, two fixes

### Bug 1 — Clipboard **read** needs user activation (Firefox is strict)

`navigator.clipboard.readText()` requires transient user activation **at call time**. The very first `await sleep(CONFIG.COPY_DELAY)` inside your `for` loop already consumes the click's activation, so every subsequent `readText()` throws:

```
Clipboard read request was blocked due to lack of user activation.
```

This is not fixable by tweaking delays — Firefox only allows one read per user gesture.

**Fix:** don't *read* the clipboard at all. Instead, **patch the page's clipboard writers** (`navigator.clipboard.writeText`, `navigator.clipboard.write`, and `document.execCommand('copy')`) at document‑start. When Brave's own "Copy" button fires, the text passes through your patch and you capture it directly. No activation needed.

### Bug 2 — API capture locks the response body without cloning

```js
if (isStream && res.body && res.body.getReader) {
    const reader = res.body.getReader();   // ← locks res.body!
```

You read from the *original* `res.body`, so the page's own reader (the one that renders the streaming answer) can't read it. Even if the URL matched, you'd either break the page or the events wouldn't arrive in the order you expect. It must be `res.clone()` first. Also, `/api/tap/v1/stream` is too narrow — Brave occasionally changes path prefixes, which is almost certainly why `buildConversationFromApiState()` returned `null` and the export fell through to clipboard mode.

---

## Patch

Replace these three sections in your file.

### A) Add clipboard-write capture right after `const __ABX = ...`

```js
// ---- Clipboard WRITE capture (avoids Firefox's readText activation requirement) ----
const __ABX_CLIP = (window.__ABX_clipboardCapture = { text: null, at: 0 });

(function patchClipboardWriters() {
    try {
        const clip = navigator.clipboard;
        if (clip) {
            const origWriteText = clip.writeText;
            if (typeof origWriteText === 'function') {
                clip.writeText = function(text) {
                    try { __ABX_CLIP.text = String(text); __ABX_CLIP.at = Date.now(); } catch (e) {}
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
                            if (t) { __ABX_CLIP.text = t; __ABX_CLIP.at = Date.now(); }
                        }
                    } catch (e) {}
                }
                return origExec.apply(this, arguments);
            };
        }
    } catch (e) {}
})();
```

### B) Fix the `fetch` wrapper (clone the body + broaden the URL match)

Replace the block from `// ---- fetch wrapper ----` down to the closing `};` of the fetch override with:

```js
// ---- fetch wrapper ----
const origFetch = window.fetch.bind(window);
window.fetch = function(input, init) {
    const url = (typeof input === 'string') ? input
              : (input && input.url) || '';
    const isStream = url.indexOf('/api/') !== -1 && url.toLowerCase().indexOf('stream') !== -1;
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
                            let idx;
                            while ((idx = buf.indexOf('\n\n')) !== -1) {
                                abxParseSSE(buf.slice(0, idx));
                                buf = buf.slice(idx + 2);
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
```

### C) Rewrite the copy helpers to use the captured text (with DOM fallback)

Replace `copyUserMessages` and `copyAIAnswers` with:

```js
// Click a copy button and capture what the page writes to the clipboard.
// Falls back to null if no write happens within `timeoutMs`.
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
            // Remove footer/action bars so we don't grab button labels.
            const clone = container.cloneNode(true);
            clone.querySelectorAll(
                '.tap-round-footer-actions, .tap-round-footer, button, [role="toolbar"]'
            ).forEach(el => el.remove());
            text = (clone.textContent || '').trim();
            if (text) console.warn('[ABX] clipboard capture failed for answer', i + 1, '- using DOM text');
        }

        if (text) answers.push(text.trim());
        else console.warn('No answer text captured for container', i + 1);
    }

    console.log('Total answers captured:', answers.length);
    return answers;
}
```

---

## Why this now works

| Failure | Before | After |
|---|---|---|
| `readText()` throws in Firefox | Required activation per call | Never called — we tap the *write* side |
| Clipboard text unavailable | — | Captured synchronously via patched `clipboard.writeText` / `execCommand` |
| API capture silently no‑ops | URL regex too strict, body locked | Broader match (`/api/*stream*`) + `res.clone()` so the page still gets its stream |
| Answers lose formatting if capture fails | Not possible before | DOM fallback (loses markdown but preserves text) |

Once the API-capture path starts matching Brave's real endpoints, you'll never touch the clipboard at all — the clipboard patch is purely the safety net for the cases where the stream endpoint changes again.