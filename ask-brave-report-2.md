# Ask Brave — Complete Technical Report (for building a downloader conversation script)

Version: 1.0 — based on live network capture (chrome-devtools/CDP + browsermcp) on `search.brave.com/ask`, Sept 23 2026.
Audience: another AI building/enhancing a conversation-downloader userscript. Reference implementation: `script.js` (v5.0) in this folder.

---

## 1. Executive summary

Ask Brave (`https://search.brave.com/ask`) is a **SvelteKit SPA** that generates AI answers over Brave Search data. There is **no public REST API** for the Ask feature — everything flows through an internal `/api/tap/v1/*` API plus server-side-rendered SvelteKit pages. A downloader script must **intercept `window.fetch`** and reconstruct conversations from:

1. **`GET /api/tap/v1/new`** — creates a conversation, returns its `id`.
2. **`GET /api/tap/v1/stream?...`** (or **`POST /api/tap/v1/stream_multimodal`** for image mode) — an SSE stream that carries the answer (markdown segments), sources, citations, tool triggers, follow-ups, usage stats.
3. **`POST /api/tap/v1/run_tool`** — fired when the model invokes an augmentation tool (`augment_with_news`, `augment_with_web`, `augment_with_images`, `augment_with_shopping`, …); the **actual result payloads** (news/web/image/shopping results arrays) live only here.

**Key facts a downloader must know:**
- The SSE stream contains **no `sources` field** (the old v4 script parsed `data.sources` — that does not exist anymore). Sources come from `initial_response` (web results), later `search`/`videos` events, and the `run_tool` responses.
- **Each new user question in the chat = a NEW conversation id.** Multi-turn continues under its *own* per-question conversation id (the UI adds it to the same chat thread; the URL `?conversation=` changes).
- **`symmetric_key`, `nonce`, `sig` rotate on every page load** and every request. They are generated client-side (SvelteKit app). Never hardcode — read them from the live request URLs or from `__data.json` (`token` = `{q, nonce, sig}` used by the *next* `/new` call).
- **Past conversations CAN be downloaded** from a share link: `GET /api/tap/v1/get_current_state?id=<convId>&symmetric_key=<#hash-fragment>&source=shared` returns the full saved conversation (deep-research timeline + cumulative full SSE event log). The `#fragment` of a share URL **is** the `symmetric_key`. (`source=shared` is required; `source=cached`/`source=session` 404.)
- Stored `augment_with_*` events have `service_response: null` — the app **re-fires run_tool** with the event's embedded `signed_params` to re-fetch the real arrays. A downloader must replay those run_tool calls (or capture them live).
- News/Images/Videos/All/Web tabs (`/news?`, `/images?`, `/videos?`, `/search?`) are **server-rendered SvelteKit pages** — data is in the initial HTML, no JSON API. A script only needs to sniff the Ask flow (`/api/tap/v1/*`).

---

## 2. The modes

| Mode | Trigger | Endpoint | Distinguishing SSE/debug | Notes |
|---|---|---|---|---|
| **Normal answer** | Question in `/ask` box | `GET /api/tap/v1/stream` | `debug_labels.category = news_and_current_events` / `general` etc.; has `initial_response` with web/news/videos | default |
| **Quick answer** | Question in the home/SERP search box (`search.brave.com` main box) | `GET /api/tap/v1/stream` | first answer labeled **QUICK ANSWER** when chat continues on `/ask` | answering in the main Brave search box produces a quick-answer card on the SERP; continuing the chat redirects to `/ask?q=...&conversation=<id>` |
| **Deep Research** | "Deep Research" toggle/intent | `GET /api/tap/v1/stream` | `debug_labels.category = deep_research`; UI shows **"Deep Research" badge + stats row** ("30 URLs analyzed / 1 Queries issued / 24s Elapsed"); stream uses `web_search` tool with `context_budget` | longer, iterative; full multi-turn allowed in one conversation |
| **Image mode** | Image attachment (multi-file allowed) | `POST /api/tap/v1/stream_multimodal` (multipart/form-data) | `debug_labels.category = image_analysis`, `has_image: True`; emits **`rag`** SSE event | `/new` uses `source=newThread&q=<label>`; `.new` for normal is `source=home` |
| **Follow-up turn** | Follow-up box / suggested chips | new conversation via `/new` + `GET stream` | — | separate conversation id, same chat thread |

---

## 3. Full API surface (all captured live)

### 3.1 POST `/api/tap/v1/has_current_state`
Body: `{"ids":["<5 conversation ids>"]}`
Response: `{"<id>": true|false}` (which stored/local conversations still have server state).

### 3.2 POST `/api/feedback`  (content-type `text/plain;charset=UTF-8`, JSON string body)
Fires constantly (page load, typing, rating, tab loads). Telemetry shapes observed:
- `{"payload":{"target":"tap", ..., "type":"query.daily","behavior":1,"meta":{"version":6,...},"static":{...,"timing":{...}}},"success":true}`
- Answer rating (Good response button):
  ```json
  {"payload":{"target":"tap","structuredFeedback":{"type":"positive","value":"helpful","label":"This is helpful"},
  "debug_url":"https://search.brave.com/ask?q=<q>&conversation=<id>&country=us&search_lang=en&spellcheck=1&show_local=1&units=metric&geoloc=30.051x31.249&index=0&bypass_cache=1",
  "meta":{"os":"Windows","browser":"Chrome","mobile":false},"version":2}}
  ```
  Response: `{"success":true}` (16 bytes). `index=N` identifies which message/segment is rated.

### 3.3 GET `/api/suggest?q=<partial>&rich=true&source=ask&country=us`
Live autocomplete JSON: `["<typed query>",[{"type":"entity"|"query","q":"...","name":"...","desc":"...","category":"...","img":"..."}]]`. Called per keystroke.

### 3.4 GET `/api/tap/v1/new` — creates a conversation
Full query-string pattern (order matters for nothing, keys matter):
```
?language=en&country=us&ui_lang=en-us&safesearch=moderate&force_safesearch=0
 &units_of_measurement=metric&use_location=1&geoloc=<lat>.<lon>
 &premium_cookie_name=__Secure-sku%23brave-search-premium
 &symmetric_key=<43-char session key>
 &source=home|newThread  (home = first question; newThread = follow-up / image)
 &q=<urlencoded query>
 &nonce=<32 hex> &sig=<64 hex>          (anti-CSRF; from __data.json token or client)
```
Response 200 JSON:
```json
{"id":"<32 hex conversation id>",
 "bo_callback_share_link":"/a/features?feature=ask_share&action=share_link&timestamp=...&nonce=...&sig=...",
 "bo_callback_open_modal":"/a/features?feature=ask_share&action=open_modal&timestamp=...&nonce=...&sig=..."}
```
`bo_callback_open_modal` (a GET to `/a/features?feature=ask_share&action=open_modal&...`) returns **204 No Content** in headless; the client share modal is driven client-side.

### 3.5 GET `/ask/__data.json?q=<q>&conversation=<id>&x-sveltekit-invalidated=01`
SvelteKit RPC hydrator. For a **fresh/existing-session conversation** it returns page shell + already-materialsed data. For a **foreign share link with no resolvable state**, it returns *only the page shell* and `token:{q, nonce, sig}` — these exact nonce+sig are used by the next `/new` call (per-page anti-CSRF token). No conversation content inside.

### 3.6 GET `/api/tap/v1/stream` — the answer SSE (normal / quick-answer / deep-research)
Query params: same as `/new` plus `&id=<convId>&query=<encoded>&symmetric_key=<key>&enable_inline_entities=true`.
Response: `content-type: text/event-stream`; each event is a line `data: {json}` separated as SSE. **Event grammar: see §4.** (Model behind answers: `qwen3.8-27b` served via `https://api.tokenfactory.us-central1.nebius.com` — see `debug_labels.answer_model`.)

### 3.7 POST `/api/tap/v1/stream_multimodal` — image mode
`content-type: multipart/form-data; boundary=----WebKitFormBoundary<hex>`. Multipart body with `part name="image_file" filename="image.jpg" Content-Type:image/jpeg` + raw image bytes (observed content-length 96054 for one JPEG). Query string: same as `/new`/`stream` + `&id=<convId>&query=describe+image&symmetric_key=<key>&enable_inline_entities=true`. Response is the same SSE grammar; **adds `rag` events** and `category=image_analysis`.

### 3.8 POST `/api/tap/v1/run_tool?symmetric_key=<key>`
Fired when the model wants to augment. Body:
```json
{"type":"tool_use",
 "id":"<tool id, e.g. 'chatcmpl-tool-<hex>' or the tool name>",
 "name":"augment_with_news",                                  // see tool list §5
 "arguments":{"q":"<refined query>","terminal":true},
 "signed_params":{"conversation":"<convId>","index":0,"q":"<q>","sig":"<64 hex>","nonce":"<32 hex>"}}
```
Response 200 = JSON **array** `[{...}]` with one element per tool: `{"type":"augment_with_X","query":"<refined>","service_response":<full payload>}`. The `service_response` shapes are detailed in §6. **This is where the real news/web/image/shopping/discussion result arrays live.**

### 3.9 GET `/api/tap/v1/get_current_state` — replaying a shared conversation
```
GET /api/tap/v1/get_current_state?id=<convId>&symmetric_key=<#hash-fragment>&source=shared
```
- `200` → `[ [timeline events], [cumulative SSE event log] ]` (see §7). The `#fragment` of the share URL = `symmetric_key`.
- `source=cached` / `source=session` → 404 (even for a session-owned conversation).
- After load, the app **re-fires run_tool for each stored `augment_with_*` event** (9 POSTs observed) using the event's embedded `signed_params` to repopulate the source arrays.

### 3.10 `GET /a/features?feature=ask_share&action=open_modal|share_link&timestamp&nonce&sig`
Share callback endpoint; observed 204 No Content (client-side modal, `content-security-policy: sandbox`, `x-frame-options: DENY`). Used by "Share" in the conversation `More ▾` menu.

---

## 4. SSE stream event grammar (normal + quick-answer + deep-research)

Each SSE line is `data: <JSON>`; events arrive in SSE-framed chunks (`\n\n`). Event types observed (counts from one deep-research conversation's stored log of 678 events; and from a normal news query's 264 events):

| type | count (DR log) | payload keys | purpose |
|---|---|---|---|
| `user` | 6 | `query, quote, initial_response, aborted, is_edit, thumbnails, document_filenames, is_from_ai_answer` | marks the start of a user turn; carries the (null-able) `initial_response` |
| `debug_labels` | 6 | `labels:["key: value", ...]` | one per turn; see §4.1 |
| `text_start` | 167 | — | begins an answer segment |
| `text_delta` | 168 | `delta` | chunks of markdown of current segment |
| `text_stop` | 167 | `text` (full segment markdown) | completes a segment |
| `augment_with_inline_citation` | 78 | `url, favicon(imgs.search.brave.com 32x32), title, snippet` | an inline citation attached to a claim in the answer |
| `inline_entity` | 47 | `conversation, name` (e.g. `"Google"`) | entity chip inline in the answer |
| `reasoning_progress` | 12 | `text` | progress status line (shown as "Synthesizing…") |
| `followups` | 6 | `followups:["Q1","Q2","Q3"]` | suggested follow-up chips; sent at end of a turn |
| `thinking_summary` | 5 | `summary` | renderable expandable button labeled with the summary |
| `tool_use` | 4 | `id, name, arguments` (no signed_params in stream) | model requested a tool (see §5) |
| `augment_with_web` | 3 | `query, service_response:null, tool_use.signed_params` | web augmentation (data re-fetched via run_tool) |
| `augment_with_videos` | 2 | same | videos augmentation |
| `augment_with_shopping` | 1 | same | shopping augmentation |
| `augment_with_news` | 1 | same | news augmentation |
| `augment_with_images` | 1 | same | images augmentation |
| `augment_with_discussions` | 1 | same | reddit-style discussions |
| `rag` | 3 | `queries:[...], urls:[...], results:[]` | **(image mode)** graph/RAG search queries the model derived |
| `search` | grown during gen | `results:[...]` | later web search event (more web results) |
| `videos` | — | `results:[{url}]` | videos search event |
| `usage` | — | `prompt_tokens, completion_tokens, reasoning_tokens` | token counts (per turn) |
| `thinking_summary` | — | `summary` | final thinking summary |
| `initial_response` | — | `service_response:{query, web, rich, news, videos, discussions}` | the big upfront bundle (see §6.1) |

**The `initial_response` bundle** (normal mode) `service_response`:
```json
{"query":{...} ,
 "web":{"type":"search","results":[{title,url,description(with <strong>),family_friendly,
         meta_url:{scheme,netloc,hostname,favicon(imgs.search.brave.com),path}, age}]},
 "rich":null, "news":null,
 "videos":{"type":"videos","results":[{url}]},
 "discussions":null}
```
In **image mode** all of web/rich/news/videos/discussions are `null`.

### 4.1 `debug_labels` (parsed as `key: value` strings)
```text
adult_query: False
answer_model: qwen3.8-27b @ https://api.tokenfactory.us-central1.nebius.com
category: news_and_current_events | general | image_analysis | deep_research
detected_language: English
geoloc: 30.051x31.249
has_document: False
has_image: False | True
header_country: eg
is_navigational: False | None
latitude: 30.051
longitude: 31.249
pipeline: v2-native
query_type: None
safesearch: moderate
ui_lang: en-us
user_country: us
user_language: en
```

---

## 5. Tool names (model-invoked augmentation)

Observed `tool_use`/`run_tool` names and their `arguments`:

| name | arguments | used in |
|---|---|---|
| `augment_with_news` | `{q, terminal:true}` | normal/news turns |
| `augment_with_web` | `{q, terminal:true}` | deep-research / general |
| `augment_with_images` | `{q, terminal:true}` | image mode & others |
| `augment_with_videos` | `{q, terminal:true}` | videos augmentation |
| `augment_with_shopping` | `{q, terminal:true}` | product/augments |
| `augment_with_discussions` | `{q, terminal:true}` | discussions |
| `web_search` | `{queries:[...], context_budget:"medium"|"low"}` | deep-research iterative search |

Note: in the live stream, `tool_use` events have **no `signed_params`**; the client constructs them. In *stored* (get_current_state) events, the `augment_with_*` wrapper events carry `tool_use.signed_params` and the client re-fires run_tool with them verbatim.

---

## 6. `service_response` payload shapes

### 6.1 News (`augment_with_news` / run_tool)
```json
[{"type":"augment_with_news","query":"<refined>",
  "service_response":{
    "type":"news",
    "query":{original, show_strict_warning, altered, cleaned, potential_alteration, safesearch, is_navigational,
             is_geolocal, local_decision, local_locations_idx, is_trending, is_news_breaking, ask_for_location,
             language, spellcheck_off, country, bad_results, lat, long, postal_code, city, header_country,
             more_results_available, state, ads_signature, location_label, local_query_type, local_query,
             coordinates, user_location_label, discussions_cluster, should_fallback, is_rh_forced,
             related_queries, search_operators},
    "rich":null,
    "news":{"type":"news","results":[
       {title,url,is_source_local,is_source_both,fetched_content_timestamp,full_title,description,page_age(ISO),
        page_fetched(ISO),profile:{name,url,long_name,img},language,family_friendly,icons,breaking,is_live,
        meta_url:{scheme,netloc,hostname,favicon}, thumbnail/images fields}]}}]
```

### 6.2 Web (`augment_with_web`)
See the `query` object above plus:
```json
"web":{"type":"search","results":[
  {title,url,is_source_local,is_source_both,fetched_content_timestamp,full_title,
   description(<strong> bold tags),page_age,page_fetched,profile:{name,url,long_name,img(32x32)},
   language,family_friendly,icons,type:"search_result",subtype:"generic"|"faq",is_live,
   deep_results,schemas,meta_url:{scheme,netloc,hostname,favicon,path},
   thumbnail:{src(imgs.search.brave.com 200x200),alt,height,width,bg_color,original,resized,logo,click_url,
              meta_url,duplicated,theme,is_tripadvisor},
   age:"December 1, 2024",location,restaurant,locations,video,movie,
   faq:{items:[{question,answer,title,url,meta_url}]},
   recipe,qa,book,rating,article,product,product_cluster,cluster_type,cluster,creative_work,
   music_recording,review,software,organization,events,content_type,side,extra_snippets}]}
```

### 6.3 Images (`augment_with_images`)
```json
"results":[{"title,url,is_source_local,is_source_both,fetched_content_timestamp,full_title,description,
   page_age,page_fetched,profile:null,language,family_friendly,icons:null,source:"<domain>",
   thumbnail:{src(imgs rs:fit:0:180:1:0),alt,height,width,bg_color,original,resized:null,logo:null,
              click_url,meta_url:null,duplicated,theme,is_tripadvisor:false},
   properties:{url(orig img),resized(imgs rs:fit:860:0:0:0),placeholder(imgs rs:fit:76:0:0:0 q:10),
               height,width,format,content_size},
   meta_url:{scheme,netloc,hostname,favicon(imgs 32x32),path:"› blog › how-to-tell-if-flac-is-real"},
   from_context:false,"confidence":"high"|"medium"|"low","similar_images_api_url":null}]
```
(`confidence` ranks image relevance; `+N` bubble and carousel come from here.)

### 6.4 Videos (`augment_with_videos`, run_tool) — VERIFIED 2026-09-23
```json
[{"type":"augment_with_videos","query":"<refined>",
  "service_response":{"type":"videos","query":{...same query obj...},
    "authors":null,"might_be_offensive":null,"web":null,          // NOTE: results NOT under .web
    "results":[{"title,url,is_source_local,is_source_both,fetched_content_timestamp,full_title:null,
       description,page_age(ISO,"2024-11-18T14:00:24"),page_fetched:null,profile:null,language:null,
       family_friendly,icons:null,type:"video_result",
       video:{duration:"30:42",views,creator:"Indently",publisher:"YouTube",thumbnail,tags,author:{name,url,img}},
       meta_url:{scheme,netloc:"youtube.com",hostname, favicon(imgs 32x32),path:"› watch"},
       thumbnail:{src(imgs rs:fit:200:200:1:0), ... original:"https://i.ytimg.com/.../maxresdefault.jpg"},
       age:"November 18, 2024",publisher:null}]}}]
```
Count verifiable: one live capture returned **50** video results; UI shows "View all 50". Video items live at `service_response.results[]` (NOT `.web.results`).

### 6.5 Shopping (`augment_with_shopping`, run_tool) — VERIFIED
```json
[{"type":"augment_with_shopping","query":"Python courses for kids and adults",
  "signature":{"product_name":"...","nonce":"<32hex>","sig":"<64hex>"},   // NOTE top-level signature
  "service_response":{"type":"shopping","provider":null,
    "results":[{"title,url,...,type:"search_result",subtype:"product",is_live:false,
       meta_url:{...},product:{
         type:"Product",name,price:"447.0",thumbnail,description,
         offers:[{url,priceCurrency:"USD",price:"447.0"}],
         rating:{ratingValue:4.8,bestRating:5.0,reviewCount:417},gtin...}}]}}]
```
Product price lives in `product.price`, offers in `product.offers[]`, rating in `product.rating{ratingValue,bestRating,reviewCount}` (this is what the "$447.00" prices in course tables come from). Shopping responses carry their **own** `signature{product_name,nonce,sig}` at the array-element level (in addition to the request-side `signed_params`).

### 6.6 Discussions/`qanda` (`augment_with_discussions`, run_tool) — VERIFIED
`augment_with_discussions` actually returns a **generic mixed SERP bundle** (NOT a dedicated discussions array):
```json
"service_response":{"ads":null,"chatllm":null,"discussions":null,"faq":null,"images":null,"infobox":null,
  "locations":null,"mixed":null,"news":null,"predicate_entity":null,"qanda":null,"recipes":null,"rich":null,
  "summarizer":null,"videos":null,
  "query":{...},                                  // original "best online python class for kids reddit"
  "web":{"type":"search","results":[
    {..., "type":"search_result", "subtype":"qa"|"generic"|"location"|"article",
     "url":"https://www.reddit.com/r/learnpython/comments/nto2pn/..."}, ...]}}
```
The UI "discussions" strip ("View all 10") = the **Reddit/forum results** in `service_response.web.results[]` whose `subtype` is `qa` (e.g. `reddit.com/r/learnpython/...` threads). So a downloader rendering a "discussions" carousel should **filter `sr.web.results[]` for Reddit/forum `subtype:"qa"` (or `url` host `reddit.com` etc.)**, not look for a `discussions.results` array (it is `null`).

### 6.7 Web (`augment_with_web`) — one shape, all subtypes
Confirmed identical across reqid 1087/1090: `service_response.web.results[]` (10 results) with `type:"search_result"`, `subtype:"generic"|"faq"|"qa"|"article"|...`, full `faq.items[]` populated when present, `profile{name,url,long_name,img}` for publisher identity, `organization{type,name,contact_points[]}` for entity results, `thumbnail.original` for the raw image URL. `chatllm/qanda/discussions/...` nullable siblings stay `null`.

---

## 7. Replaying a shared conversation (`get_current_state`)

**Share URL format** (valid, works in Firefox/other browsers):
```
https://search.brave.com/ask?q=intro+to+python+...&conversation=099882dcee1c82190517ec911067a371eafd#X4jo8JXe0vQjnL349pNWfEuN7r8vySUqXrXLEBDlbXU
```
The `#` fragment is mandatory and **is the `symmetric_key`**.

Flow a downloader must replicate to open/export a shared conversation:
1. `POST /api/tap/v1/has_current_state` (lists own local sessions; the shared id is absent).
2. `GET /api/tap/v1/get_current_state?id=<id>&symmetric_key=<#hash>&source=shared` → **200** `[ [timeline], [eventLog] ]`.
3. For each `augment_with_*` event with `service_response:null`, the client re-fires `POST /api/tap/v1/run_tool` with the event's `tool_use.signed_params` (verbatim) to materialize the real arrays — **a downloader must do the same** (9 run_tool calls observed).
4. Re-render from the re-fetched data.

**Stateless access — VERIFIED in an isolated cookie-less Chrome context (2026-09-23):** opening the share URL in an isolated incognito-like browser context (no session cookies, brand-new profile) immediately produced `get_current_state` → 200 and rendered the full 6-turn Deep Research conversation; the same 9 run_tool re-fires fired. The `#hash` fragment is entirely self-sufficient — **no login/cookies/session required** to read + materialize a shared conversation, which is what makes the "download from a share link" feature viable for a script.

**Per-turn subordinate conversation ids — VERIFIED:** the 9 re-fired run_tool `signed_params` reference **different conversation ids per turn** (`0998b5da…`=turn0, `099837e2…`=turn1, `099823f4…`=turn4, `099882dcee…`=turn5), with `index` mapping to the turn. The URL `conversation=` param is only the *first* turn's id. A downloader must therefore key re-fetch association by `signed_params.conversation + signed_params.index`, never by the URL id alone.

**Why my earlier test failed (pseudo-404):** I requested with `source=cached`/`source=session` and no `symmetric_key`. `source=shared` + the hash fragment is what makes it work. Also note: if the shared conversation has truly expired server-side, the app falls back to creating a *fresh* conversation with `source=home` and running a live stream (bonus for downloader design: the fallback is a good clean generation).

### 7.1 Element [0] — deep-research timeline (12 events)
```json
{"event":"queries","queries":["<user query>"]}
{"event":"analyzing","query":"...","urls":24,"new_urls":24}
{"event":"thinking","query":"...","chunks_analyzed":80,"chunks_selected":80,"urls_analyzed":30,
 "urls_selected":["30 urls"],"urls_info":{...}}
{"event":"ping"}                       // heartbeats
{"event":"answer","final":false|true,"answer":"<full markdown>",
 "citations":[{"event":"citation","start_index":N,"end_index":N,"number":N,
               "url":"...","favicon":"imgs 32x32","snippet":"..."}]}   // character-range indices into answer
{"event":"insights","insights":{"<url>":["<snippet strings>"]}}
{"event":"stopping_condition","reason":"Final answer provided"}
{"event":"progress","elasped_seconds":24.5,          // NOTE: typo "elasped" in the API
 "number_of_iterations":1,"number_of_queries":1,"number_of_urls_analyzed":30,
 "number_of_snippets_analyzed":80,"number_of_input_tokens":11363,
 "number_of_thinking_tokens":0,"number_of_output_tokens":1267}
```

### 7.2 Element [1] — cumulative SSE event log
Every event from §4 in order, across **all turns of one conversation id** (multi-turn is stored under ONE top-level conversation). Includes `user` events marking each turn (with `is_edit`, `aborted`, `is_from_ai_answer` flags), `debug_labels` per turn, and the `augment_with_*` wrappers (with signed_params) whose data a downloader must re-fetch via run_tool. `tool_use` events in the log carry `id`/`name`/`arguments` but null signed_params.

---

## 8. UI anatomy (for a downloader that must also observe/target the DOM)

**Layout (fresh `/ask`):**
- Top-left sidebar: Brave logo; **"New conversation"** button (shortcut **Ctrl+Shift+O**); conversation list (each item titled by first user message, with `More ▾` menu → **Share / Delete**); bottom **Settings** button (`#settings-button`, gear svg — headless no-op).
- Nav tabs (right side / header): **Ask / All / Images / News / Videos / Maps / Goggles** → `/ask`, `/search?q&source=ask&summary=0`, `/images?q&source=ask`, `/news?q&source=ask`, `/videos?q&source=ask`, `/maps/search`, `/goggles`.
- Conversation URL when active: `/ask?q=<encoded>&conversation=<32 hex>`. Follow-ups reuse the same URL shape with a **new conversation id**.
- Per-conversation in-page TOC anchors (e.g. `#1-root-cause-sandbox-escape`).

**Conversation thread (per user turn):**
- User message block: text + `Copy` (copies the question) + `Edit` buttons (prefills the main input).
  - Follow-up input is a *second* textarea (`placeholder="Ask a follow-up question"`); main box placeholder `"Search"`.
- Answer block:
  - Markdown rendered: headings h2/h3 (decorated with `#<slug>` anchors), tables (with a **"Tools"** button → Export CSV / Copy CSV / Copy Markdown — Copy Markdown preserves `:inlineCitations{data="<JSON>"}` markers embedded after cited claims), **bold**, lists.
  - **Inline citation buttons**: numbered, appear after claims (from `augment_with_inline_citation` events). Hover/click → source card.
  - **Source cards** row: favicon (`imgs.search.brave.com/.../rs:fit:32:32:1:0/...`), netloc, title, relative age ("18 hours ago"). Represents the current carousel of sources from `initial_response`/`search`/`run_tool`.
  - **Videos/images/shopping/discussions carousels** (youtube/thumbnail cards with durations, prices, view counts).
  - Carousel controls: `🌐 View all N` (from `initial_response`/event counts), **Previous/Next** (disabled at ends), a site-name link to Brave search of refined query (e.g. `/news?q=...`, `/images?q=...`, `/videos?q=...`, `/search?q=...`).
  - **"View all N" opens a right-side drawer** `DIV.ask-right.svelte-t22puq.open > .ask-right-scroll > .sidebar-content > .news-items > a.news-item.svelte-1v7fbed` (favicon 32x32 + netloc + title `line-clamp-2` + age). No server round-trip — items were already in the DOM from the stream.
  - Collapsible "Synthesized AI news roundup" / "Retrieved … details" rows (`thinking_summary`/`reasoning_progress`).
  - Follow-up suggestion chips (3) + **"Elaborate"** button — clicking a chip/user input starts a new conversation (`/new`+`stream`).
  - Per-segment action buttons: **Copy** (copies full answer as markdown; strips inline-citation markers), **Try again**, **Good response** / **Bad response** (→ `/api/feedback` with `structuredFeedback`).
- **Input row**: multiline textarea + voice button + **Ask** button (disabled when empty). Edit-in-progress swaps the row for `textarea + Cancel + Send` buttons.
- Footer: *"AI-generated answer. Please verify critical facts."*

**Deep Research rendering**: conversation header shows a **"Deep Research"** badge, stats row **"30 URLs analyzed / 1 Queries issued / 24s Elapsed"**, and an **"Answer outline"** list — then the normal thread with every turn.

---

## 9. Reconstruction data model for the downloader

The script should group **per conversation id**:

```
conversation {
  id, query, created, mode (normal|image|deep_research),
  labels (from debug_labels scratch),
  turns: [ per user event {
    query, is_edit, aborted, is_from_ai_answer,
    segments: [ {index, text, citations:[]} ],
    inlineCitations: [ {url,favicon,title,snippet} ],
    inlineEntities: [ names ],
    webResults: [], newsResults: [], videoResults: [],
    imageResults: [], shoppingResults: [], discussionResults: [],
    toolUses: [ {name, arguments, signed_params} ],
    rag: [ {queries,urls} ],
    followups: [], usage: {prompt,completion,reasoning}, thinkingSummaries: []
  } ]
}
sources (flattened, with kind web|news|video|image|shopping|discussion|citation)
```

**Linking run_tool responses to turns:** each run_tool call corresponds (by `signed_params.conversation` + `query`) to an `augment_with_*` event that arrived in the same turn's stream window (or in stored logs, to the wrapper event that preceded the client re-fire). Associate by matching `signed_params` / `query` string.

**`:inlineCitations` markers** in markdown (only present in *copied* table markdown, not in raw `text_stop`): `:inlineCitations{data="<HTML-escaped JSON [{"url","favicon","title","snippet"}]>"}`. The claimed source of the real citation buttons is `augment_with_inline_citation` events — prefer those.

---

## 10. Gotchas & pitfalls for a sniffing/downloader script

1. **No `data.sources` field.** Old scripts parsing `data.sources[].url/title/snippet` find nothing — the current API has no such field anywhere in the SSE.
2. **`symmetric_key` rotates every page load** (observed: `JWFa29m1EU0oqRwGxNB-WCVagRqFHlYVCleec-BKJLA`, `LoHl-2I6P78rFueTnqRdpDUjXph1PZCkOFYEaCDTbLc`, `E8uUHrV5bCOuLTq-9Jfb2Eqk0KOfA3vYu2uGE3zpE4U`, `X4jo8JXe0vQjnL349pNWfEuN7r8vySUqXrXLEBDlbXU`). Read it live from request URLs; never hardcode.
3. **nonce/sig anti-CSRF**: every `/new`/`stream`/`run_tool` request carries a per-request nonce (32 hex) + sig (64 hex). Grab them from the live request URLs (the SvelteKit app generates them client-side). For a replayed shared conversation they come from `__data.json` `token` (→ next `/new`) and from stored `signed_params` (→ run_tool).
4. **Multi-turn = multiple conversation ids.** Each new user question creates a new conversation; link turns to the enclosing thread, not by tracking a single id.
5. **augment payloads arrive OUT-OF-BAND.** The stream's `augment_with_*` events carry `service_response:null`; the real arrays are in subsequent `run_tool` POST responses. Intercept both.
6. **`get_current_state` needs `source=shared` + the `#fragment` as `symmetric_key`.** `source=cached`/`session` 404. Without the fragment, an old/foreign conversation cannot be recovered; the app silently starts a fresh conversation.
7. **`signed_params.conversation` ≠ URL `conversation` param** when replaying a shared conversation (e.g. `0998b5da…` vs `099882dcee…`). Use `signed_params` verbatim.
8. **`elasped_seconds` is a typo** in the deep-research `progress` event — parse it as such.
9. **News/Images/Videos/All/SERP tabs are server-rendered** — no fetch to intercept; a script that only taps `window.fetch` won't see their data (it's in initial HTML). Optional: capture via DOM serialization.
10. **`/api/feedback` bodies are `text/plain` JSON strings**, not `application/json` — clone as text.
11. **imgs.search.brave.com URLs**: favicons use `rs:fit:32:32:1:0`, thumbnails `rs:fit:200:200:1:0` (or `0:180`), image-placeholder `rs:fit:76:0:0:0 q:10`. No auth needed. Some upstream thumbnails 403 (e.g. politico) — don't fail the capture on image errors.
12. **`__data.json` `token:{q,nonce,sig}`** == exactly the nonce+sig used by the following `/new` call. Useful if you must construct requests offline.

---

## 11. Reference implementation notes (script.js v5.0)

`script.js` (v5.0, 334 lines, Tampermonkey, `@run-at document-start`, `@match search.brave.com/*` + `*.brave.com/*`, `@grant none`) demonstrates:
- `window.fetch` override dispatching on URL: `stream` → tee the Response body; buffer SSE frames (`\n\n`), split `data: ` lines, `routeSSEEvent` per type; `run_tool` → `handleRunTool` (clone json/text, store `{url,requestBody,response,timestamp}`, and feed `payload.service_response.news.results` into `conv.newsResults` when type is `augment_with_news`); `/new` → capture `d.id` as conversation key + query; `has_current_state` / `feedback` / `suggest` → capture request+response (feedback extracts conversation id via `/conversation=([0-9a-f]+)/`).
- Data structure: `window.__askBraveSniff = cap {version,generated,run-counters, conversations{}, streams{}, toolCalls{}, newRequests[], hasCurrentState[], feedbacks[], suggests[]}`.
- `downloadCapture()` → downloads `brave-sniff-<ts>.json` report `{meta, conversations, sources(flattened kinds web/news/video/citation), streamEvents, toolCalls, newRequests, hasCurrentState, feedbacks, suggests}`.
- `parseInlineCitations(markdown)` + `stripInlineMarkers()` for `:inlineCitations{data=…}` markers.

**Gaps to close when extending it** (feed-forward for the next AI): handle `stream_multimodal` (image mode — multipart bodies, `rag` events, `augment_with_images`), `get_current_state` replay (`source=shared`, fragment-as-key, then re-fire run_tool per stored augment event), `web_search` + `augment_with_web/shopping/discussions` tool names, multipart request-body capture (current fetch override sees `postBody:null` for multipart), and turn-grouping by `user` SSE events for multi-turn reconstruction.

*— End of report. All endpoints, event grammars, payload shapes, and flows above were observed directly from live network capture on 2026-09-23.*
