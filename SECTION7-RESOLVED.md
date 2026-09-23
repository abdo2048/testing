# Section 7 — Open Items: RESOLVED

This document resolves both OPEN ITEMS from `ASK-BRAVE-RESOURCES-KNOWLEDGE-2.md` §7, based on live network capture. It supersedes the "Still needs 1 live SSE capture" status in the TODO matrix (row 1).

---

## Item 1 — Exact shape of video/image/news/discussion/shopping result arrays ✅ RESOLVED

> (we saw the trigger events; their `service_response` was null in cached state — need a live SSE capture to see payloads)

**Correction to the premise:** the payloads do **not** arrive in the SSE stream. By design, SSE `augment_with_*` events carry `service_response: null`; the actual result arrays arrive via **`POST /api/tap/v1/run_tool` responses**. When a shared conversation is loaded, the client re-fires one run_tool per stored augment event (9 POSTs observed; reqids 1084–1091). So a capture must target **run_tool responses**, not the SSE.

Full shapes captured live (evidence files in `C:\Users\Ad2048\AppData\Local\Temp\opencode\`):

| Tool | sr.type | where results live | count | shape summary | evidence |
|---|---|---|---|---|---|
| `augment_with_videos` | `videos` | `service_response.results[]` (NOT under `.web`) | 50 | `{type:'video_result', title, url(youtube watch), description, page_age ISO, age:'November 18, 2024', video:{duration:'30:42', creator, publisher:'YouTube', tags[], author:{name,url('http://www.youtube.com/@...'),...}}, meta_url:{netloc:'youtube.com', path:'› watch'}, thumbnail:{src(imgs rs:fit:200:200:1:0), original:'https://i.ytimg.com/vi/<id>/maxresdefault.jpg'}}` | `rt1084.res.network-response` (83KB) |
| `augment_with_shopping` | `shopping` | `service_response.results[]` | 1 | Element carries its **own top-level `signature:{product_name, nonce, sig}`** in addition to request signed_params. `{type:'search_result', subtype:'product', product:{type:'Product', name, price:'447.0', offers:[{priceCurrency:'USD'}], rating:{ratingValue:4.8, bestRating:5.0, reviewCount:417}}}` | `rt1086.res.network-response` (3KB) |
| `augment_with_discussions` | generic SERP (type field is the generic query form; sr.keys incl `web`, all others null) | `service_response.web.results[]` filtered by `subtype:'qa'` / reddit host | 10 | **NOT a dedicated discussions array** — semantics: the UI Reddit/forum strip ("View all 10") = web results with `subtype:'qa'` (reddit.com/r/learnpython/comments/... etc.) | `rt1085.res.network-response` (81KB) |
| `augment_with_web` | search | `service_response.web.results[]` | 10 | `{type:'search_result', subtype:'generic'|'faq'|'qa'|'article', profile:{name,url,long_name,img(imgs 32x32)}, organization:{...}, faq.items:[{question,answer}], thumbnail.original}`; description has `<strong>` | `rt1087` (39KB) + `rt1090` (26KB) |
| `augment_with_news` | news | `service_response.news.results[]` | 24 | `{title, url, profile:{name:'Real Python'}, breaking:false, is_live:false, thumbnail.src(imgs), age:'2 weeks ago', page_age ISO}` | `rt1091` (44KB) |
| `augment_with_images` | images | `service_response.results[]` | — | `{source:'<domain>', confidence:'high'|'medium'|'low', thumbnail:{src(imgs rs:fit:0:180:1:0)}, properties:{resized(rs:fit:860:0:0:0), placeholder(rs:fit:76:0:0:0 q:10)}}` | captured earlier (image-mode conversation) |

### Implementation pointers for the exporter
- Capture `run_tool` response bodies; associate each with its trigger by matching `signed_params`/`query` (and the wrapper `augment_with_*` event in the stream/log).
- **Do not** parse `service_response` from SSE events — it is always null there.
- Shopping/rating/prices shown in answer tables come from `product.price` / `offers[]` / `rating{ratingValue, reviewCount}`.
- `augment_with_images` `confidence` field ranks which images belong to the answer strip.
- Videos canonical URL: `thumbnail.original` (i.ytimg.com maxresdefault) or `url`.

---

## Item 2 — Do shared-link pages expose the same state WITHOUT auth? ✅ RESOLVED: YES (verified)

**YES — verified in a fully isolated, cookie-less Chrome context** (new browser context `no-cookies-prove`, no login, no session):

- Loaded the share URL incl. the `#` fragment:
  `https://search.brave.com/ask?q=...&conversation=099882dcee1c82190517ec911067a371eafd#X4jo8JXe0vQjnL349pNWfEuN7r8vySUqXrXLEBDlbXU`
- `GET /api/tap/v1/get_current_state?id=099882dcee...&symmetric_key=X4jo8JXe0vQjnL349pNWfEuN7r8vySUqXrXLEBDlbXU&source=shared` → **200** with full conversation `[timeline, SSE-event-log]`.
- Client then re-fired the 9 `run_tool` POSTs (same as item 1), and the full 6-turn conversation rendered: Deep Research badge, "30 URLs analyzed", 37 source links, footer.

**The `#` fragment IS the complete authorization.** `source=shared` is required; `source=cached`/`source=session` → 404.

### Impact on the exporter's architecture
- A **standalone converter / bulk exporter can work without any login**, as long as it has the share URL (with fragment) or a saved `symmetric_key`. This de-risks the "API mode" path — though the HMAC `signed_params` (nonce/sig per request) still means actual re-fetching (run_tool) must originate from a browser context that can mint requests with the correct referer/cookies as the SvelteKit app does.

---

## Re-run protocol (if a fresh probe is ever needed)
1. Open `https://search.brave.com/ask?q=<q>&conversation=<id>#<hash>`.
2. Observe network (filter `fetch`): expect `has_current_state` → `get_current_state?source=shared` → N × `run_tool?symmetric_key=<hash>`.
3. Save each `run_tool` response body (JSON array; element has `service_response.<type>`).
4. Optionally prove statelessness: repeat in an isolated cookie-less browser context.

---

## TODO status matrix — updated rows

| Item | Former status | New status |
|---|---|---|
| Media gallery payload shapes (§7 item 1) | "Still needs 1 live SSE capture" | **RESOLVED** — captured via run_tool responses; see above |
| Shared-link state without auth (§7 item 2) | — | **RESOLVED** — verified stateless |
| Bulk export via conversation IDs | "Endpoint confirmed, ready to implement" | **Ready** — `get_current_state` + re-fire run_tool is the recipe |
| PDF print CSS (issue #1) | Not started | unchanged |
| Firefox clipboard permission (issue #3) | README workaround | unchanged |
| Spanish/localized copy buttons (issue #5) | Selector strategy defined | unchanged |
