# Design: original reading format, diagrams, and Aha Learning

Status: **approved (2026-11-26) with the recommended defaults for D1–D7**, plus user-entered learning topics with
an AI safety check (§3.1). Building in the order below. Three features, in the order they should be built:

1. **Keep the original reading format.** Articles are stored and shown as Markdown, so bold, italics, links,
   tables, quotes and nested lists survive.
2. **Show as diagram.** Draw a diagram from one paragraph, several paragraphs, or the whole article. Zoom in and
   out, and up to 3 retries for a different diagram.
3. **Aha Learning.** From an article, pick related topics and a depth. The AI builds lessons with interactive
   exercises: which one is correct, find the error, write your own SQL.

Each feature lists what the user sees, how it works, data and API changes, security, and the decisions needed.
Open decisions are collected at the end (§5). Each has a recommended default.

---

## 1. Keep the original reading format (Markdown)

### Problem
Today every source (paste, web page, PDF, Word, Markdown) is flattened into a simple block format: headings,
paragraphs, flat lists and code. Bold, italics, links, tables, block quotes, nested lists and images are lost, and a
Markdown upload loses its formatting on purpose. Readers lose meaning that the author put in the formatting.

### What the user sees
- Articles keep their formatting:
  - **bold**, *italics* and `inline code`;
  - links (open in a new tab);
  - tables (scroll sideways inside the table on phones);
  - block quotes, nested lists, task lists and horizontal rules;
  - images (see decision D1).
- Selecting, explaining, saved-concept marks, bookmarks and reading progress all keep working over formatted text.
- **Edit article** shows the Markdown source with a **Preview** tab.
- When **pasting text** that looks like Markdown, the paste box offers "Keep Markdown formatting" (on by default when
  detected; see D2).

### How it works

**Storage.** `Article.content` holds Markdown: CommonMark plus the GitHub extras (tables, task lists, strikethrough,
footnotes). A new column `Article.format` is `"markdown"` for new articles and `"blocks"` for old ones. The old block
format is already almost valid Markdown, so a one-off migration can convert old rows and drop the column later.

**Parser (decided 2026-11-26): `marked` 18.2.0**, using only its tokenizer (`Lexer`), never its HTML output.
It has no dependencies (the `mdast` family needs more than 25), it was released at least two weeks ago, and a
prototype confirmed it produces a tree with headings, strong/em, links (with their address), inline code, block
quotes, nested lists, task checkboxes and GFM tables. Raw HTML comes out as its own `html` token, and the renderer
drops it.

**Rendering, without HTML.**
- Parse with a maintained Markdown parser that produces a syntax tree (for example `mdast-util-from-markdown` plus the
  GFM extensions). Render that tree to React elements ourselves.
- **Never** use `dangerouslySetInnerHTML`, and never render raw HTML from the source: HTML nodes are dropped.
- Links: only `http`, `https` and `mailto` are allowed, with `rel="noopener noreferrer nofollow"` and
  `target="_blank"`. Other schemes (such as `javascript:`) become plain text.
- Every top-level block element keeps its `data-p` index, so bookmarks, progress and explanations still point at
  blocks.

**Selection and marks over formatted text.**
- Selection already measures positions with browser `Range`s, so nested elements (bold, links) inside a block
  work as-is. The text sent to the AI is the rendered text, without Markdown symbols.
- Saved-concept marks and the active highlight are currently `<mark>` elements spliced into the text, which breaks
  when the text is split across bold and link elements. **Switch to the CSS Custom Highlight API**
  (`CSS.highlights`). It paints ranges without changing the page structure, and current Chrome, Safari and Firefox
  support it.
- A tap on a saved concept is detected by position (`offsetAtPoint`, already in the code) instead of a click on a
  `<mark>`.
- Older browsers fall back to showing no concept marks; explaining still works.

**Each source keeps more.**

| Source | Today | New |
|---|---|---|
| Paste | Plain blocks | Markdown when it looks like Markdown, otherwise plain paragraphs (D2) |
| Web page | HTML → blocks | HTML → Markdown: keeps strong/em, links, tables, quotes, nested lists, image alt text |
| Word (.docx) | mammoth HTML → blocks | Same HTML → Markdown converter: bold, italics, links, tables and nested lists survive |
| Markdown (.md) | Converted to blocks, syntax removed | Stored as Markdown (front matter removed, raw HTML dropped) |
| PDF | Positioned lines → blocks | Unchanged in phase 1; bold and italics from font names can come later |

**What doesn't change:** the 200,000-character cap, the upload safety checks, and the AI input limits. The AI always
receives rendered text, never Markdown symbols.

### Changes
- Schema: `Article.format`, plus a data migration for existing rows.
- New `src/lib/markdown/` (parse, sanitize, render-tree helpers shared by server and client).
- Rewrite `ArticleBody.js` around the syntax tree; switch marks to the Highlight API.
- Update `extract.js` (HTML → Markdown), the Word path, the Markdown upload path and the editor preview.
- Excerpts, search and plain-text helpers use the rendered text.

### Risks
- **Biggest:** selection, marks and bookmarks over nested inline elements. The existing e2e suite (reader, bookmarks,
  marks) is the safety net, and new tests cover formatted text.
- **Very long tables or deeply nested lists on phones:** tables scroll inside their own box, as code blocks do today.

---

## 2. Show as diagram

### What the user sees
- **Ways to start:**
  - Select any passage, from one sentence to several paragraphs, and tap **Diagram** next to "I don't understand"
    and Bookmark.
  - The reader's top bar has **Diagram the whole article**.
- **The result:** a diagram panel opens, full width on phones and a large dialog on desktop. If the text doesn't lend
  itself to a picture, the panel says so and suggests selecting a process, a system or a comparison.
- **Diagram types:** flow or steps, structure (parts and connections), sequence (who calls whom, in order),
  hierarchy, comparison (side-by-side table), and timeline.
- **Zoom:** **+** / **−** / **Fit** / **100%** buttons, pinch-zoom and drag to pan on touch screens, the mouse wheel
  and drag on desktop, and the keyboard (`+`, `−`, `0`). There is also a full-screen mode.
- **Retries:** **Try a different diagram**, up to **3 retries** (4 versions in total) for the same selection. Each
  retry asks for a different angle: another diagram type or level of detail. The versions appear as "1 / 4", and you
  can flip between them.
- **Saving:** save the chosen version to the Notebook with the selection, or bookmark it.
- **Accessibility:** every diagram has a text version ("Steps: 1. … 2. …"), shown in a tab and read by screen
  readers. Color is never the only signal.

### How it works

**Input.**
- **A selection:** up to 12,000 characters. The explain limit of 1,000 characters doesn't apply to diagrams.
- **The whole article:** if it's longer than 12,000 characters, the server builds a digest without AI (headings plus
  the first sentences of each section, up to 12,000 characters) and diagrams that.

**The AI returns a diagram spec, never drawing code:**

```json
{ "drawable": true,
  "type": "flow",
  "title": "How a quorum read works",
  "nodes": [{ "id": "c", "label": "Client", "detail": "sends read", "group": "app" }],
  "edges": [{ "from": "c", "to": "r1", "label": "read" }],
  "groups": [{ "id": "app", "label": "Application" }],
  "textVersion": ["Client sends a read to 3 replicas", "…"] }
```

or `{ "drawable": false, "reason": "…" }`.

**Server checks before anything is stored or shown:**
- the JSON shape is correct;
- at most 20 nodes and 30 edges;
- labels at most 60 characters and details at most 140;
- ids are unique, and edges point at real nodes;
- the type is allow-listed;
- labels pass the same invisible-character and meta-commentary checks as explanations.

A spec that fails is retried once, then the user is told "couldn't draw this one".

**Drawing:**
- A layout library (`elkjs`, or `dagre` for simpler graphs) positions the boxes, and React renders the SVG. Labels
  are text nodes, so nothing the AI writes can run as code.
- Comparison and timeline types use their own simple layouts.
- Zoom and pan are a transform on the SVG.
- The layout library loads only when a diagram is opened, so the reader stays light.

**Retries:**
- The server counts versions per user and per source. A retry sends the previous versions' types and titles, plus
  "produce a different perspective (another type or level of detail)".
- After 4 versions, the button is disabled with "You've tried 3 alternatives for this selection".
- Each version counts toward the daily AI quota.

### Data and API
- `Diagram`: `id, userId, articleId, scope ("selection" | "article"), sourceHash, quote (≤300), versions JSON[] (spec + createdAt), chosen, createdAt`.
- `POST /api/diagrams`: `{articleId, scope, text?}` → the first version, or "not drawable".
- `POST /api/diagrams/:id/retry`: the next version, or 409 `retry_limit`.
- `PATCH /api/diagrams/:id`: `{chosen}`.
- `GET /api/diagrams?articleId=`.

### Security
- The selected text and the article digest are untrusted, so they're fenced in the user turn, with rules first in
  the system turn, as for explanations.
- The output is data, validated against strict rules, and drawn by our code.
- A source can't push more than 4 versions.
- Rate limit and daily quota apply.
- The prompt goes through the same AI-engineer review as the explain prompts.

---

## 3. Aha Learning

### The idea
Reading is where the learning starts. From any article, for example an uploaded data-warehouse project PDF, the user
opens **Aha Learning**. The AI suggests the skills the article relies on (SQL, dimensional modeling, ETL/ELT, data
quality, partitioning…). The user picks topics and depth, and gets short lessons with hands-on exercises that adapt
as they go.

### What the user sees
1. **Start:** **Learn from this** in the reader's top bar and on Library cards. A setting (Settings → Aha Learning)
   turns the suggestions on or off.
2. **Pick topics:**
   - **Suggestions:** 4–8 related topics, each with a one-line reason ("The article's fact tables are built with SQL
     joins and window functions"), a suggested depth, and a few example skills.
   - **Your choice:** you can add your own topic ("dbt").
   - **Per topic:** you set the depth: **Foundations**, **Working knowledge** or **Advanced**.
   - **Overall:** you pick a goal (understand this article / job skills / interview prep) and a session length (5,
     10 or 20 minutes).
3. **Plan:** each topic becomes a short path of 3–8 lessons. You can reorder, remove, or add "more like this".
4. **Lesson:** a short explanation in Markdown, with examples taken from the article where possible ("in your PDF,
   `fact_sales` joins `dim_date`…"), followed by 3–6 exercises.
5. **Exercises (v1):**

   | Type | What you do | How it's checked |
   |---|---|---|
   | **Which one is correct** | Pick one of 3–4 options | On the server, from a stored answer key. Each option has an explanation |
   | **Find the error** | Tap the faulty line in a SQL query, code or statement, then optionally say why | Server checks the line; the AI gives feedback on your "why" |
   | **Write your own SQL** | Write a query against a small practice database built for the lesson, run it, and see your result next to the expected one | Result sets are compared (rows, column count, order when the task asks for it); see D5 |
   | **Short answer** | Explain in a sentence or two | The AI grades against a rubric, with feedback (no score shame) |

   Later: put the steps in order, fill in the blank, predict the output.
6. **Feedback:** right away and specific. "Show a hint" (up to 2) and "Show solution" come after an attempt. A missed
   exercise joins the existing **Review** schedule, so it comes back later.
7. **Progress:** each topic shows mastery (the share of exercises answered correctly on first or second try, recent
   ones counting more), plus "next lesson". A Learn page lists all plans.

### How it works
- **Generation is lazy.** One AI call proposes topics. Each lesson is generated only when opened (lesson text and
  exercises in one structured JSON reply). Nothing is generated for lessons the user never opens.
- **Grounding:** lesson prompts include a digest of the source article (as for whole-article diagrams), so examples
  match what the user is reading. The digest is fenced as untrusted data.
- **Strict JSON:** every exercise is validated against a schema. For example, a multiple-choice question must have
  exactly one correct option, and a find-the-error answer must point at an existing line.
- **Answer keys:** keys for multiple-choice and find-the-error stay on the server until the user answers.
- **The SQL practice database, entirely in the browser:**
  - The lesson defines a small schema and seed data: at most 5 tables and 200 rows each. Data is generated, never
    taken from the user's files.
  - The app loads an in-browser SQL engine (DuckDB-WASM, see D4), creates the tables, and runs the user's query.
  - It runs inside the browser's sandbox, with no network and no access to the app's real database.
  - A query that runs too long is stopped after 5 seconds.
- **Checking generated SQL exercises:** when an exercise is first opened, the reference query is run against its
  dataset. If it fails or returns nothing, the exercise is marked broken and quietly regenerated, so users never see
  an exercise whose own answer is wrong.

### 3.1 Topics the user types in (approved addition)

Users may add their own topics ("dbt", "window functions") as well as picking suggestions. A typed topic is
untrusted input that later goes into AI prompts, so it passes **two independent checks before it is accepted**, and is
still treated as untrusted data afterwards.

**Layer 1: fixed rules on the server, no AI**
- 2–60 characters after trimming. Letters (any language), digits, spaces and `+ # . - / & ( ) ' ,` only.
- No URLs, email addresses, code fences, angle brackets or braces, and no invisible, control or bidi characters.
- No instruction-like phrases: an allow-list of characters plus a deny-list ("ignore", "system prompt",
  "instructions", "you are", "act as", "jailbreak", "developer mode", role markers like "assistant:").
- At most 5 typed topics per plan.
- Validation requests are rate-limited (10 per hour per user).

Failing this layer gives an immediate, specific message ("Use a short topic name, like 'SQL window functions'"),
and no AI call is made.

**Layer 2: an AI safety check**
- **Separate call:** a small, cheap model call that's separate from content generation, with its own fixed system
  prompt (rules first; the topic and the article title fenced as data).
- **Strict JSON answer:** `{verdict: "accept" | "reject", category: "ok" | "harmful" | "injection" | "not_a_topic" | "personal_data", normalizedTopic, reason}`.
  The server validates the JSON: an unknown verdict or category, or a malformed reply, counts as **reject**.
- **Accept only if** it's a real, learnable subject (a skill, concept, tool or field), it's suitable for an
  educational app, and it isn't an attempt to steer the AI.
- **Reject:**
  - harmful subjects: how to make weapons or drugs, self-harm, sexual content, hate, or attacking systems;
    security *concepts* such as "SQL injection prevention" are fine;
  - instructions disguised as topics;
  - personal data;
  - nonsense.
- **Normalized name:** on accept, the plan stores `normalizedTopic` (for example "dbt (data build tool)"), not the
  raw input. It is then re-checked by Layer 1.
- **Fail closed:** if the safety check can't run (AI unavailable, timeout, invalid reply), the topic is **not
  added**. The user sees "We couldn't check that topic right now; try again in a moment." Suggested topics from the
  AI skip this step, because they come from our own prompt, but they still go through Layer 1.

**After acceptance**
- The topic is always fenced as untrusted data in lesson and exercise prompts. It never appears in a system turn.
- Every generated lesson still passes the normal output checks.
- Rejections are logged at WARN with the category only. The topic text is redacted and not stored.

**Tests:** a deterministic table of hostile inputs for Layer 1 (injection phrases, markers, URLs, bidi characters,
oversize); mock-AI cases for each verdict and for malformed replies; live tests for the AI check (gated like the other
live AI tests); and an end-to-end flow where a rejected topic shows its message and an accepted one appears normalized.

### Data and API
- `LearningPlan`: `id, userId, articleId?, goal, sessionMinutes, createdAt`.
- `PlanTopic`: `id, planId, name, depth (1–3), reason, order, status`.
- `Lesson`: `id, topicId, order, title, contentMd, status (pending | ready | broken), generatedAt`.
- `Exercise`: `id, lessonId, type, promptMd, payload JSON (options / code lines / schema+seed / rubric), answerKey JSON (server only), explanationMd, order`.
- `Attempt`: `id, exerciseId, userId, answer JSON, correct, feedback, createdAt`.
- Endpoints:
  - `POST /api/learning/suggest` `{articleId}` → topics.
  - `POST /api/learning/topics/check` `{topic, articleId?}` → `{accepted: true, topic: normalizedTopic}` or
    `{accepted: false, category, message}` (§3.1).
  - `POST /api/learning/plans`.
  - `GET /api/learning/plans/:id`.
  - `POST /api/learning/lessons/:id/generate`.
  - `POST /api/learning/exercises/:id/attempt`.
  - `GET /api/learning/progress`.

### Security and cost
- **Untrusted input:** article text, the user's own topic names and free-text answers are all fenced, as
  explanations are. A topic name is limited to 60 characters and allow-listed characters.
- **The browser SQL engine:**
  - It loads from our own files, never a CDN.
  - The security policy needs `'wasm-unsafe-eval'` in `script-src` and a worker allowance. This is the only security
    policy change, and it applies only to pages that load the engine.
  - Its network features are disabled, so a query can't fetch anything.
- **Cost:**
  - **One plan:** about 1 call for topics, plus 1 per opened lesson, plus 1 per graded short answer.
  - **Daily limits:** generation counts toward the daily AI quota, with a separate daily cap on lessons (D6).
  - **Model:** a cheaper model can be used for generation and grading (`AI_LEARNING_MODEL`).

---

## 3A. Aha Listening (audio learning), proposed 2026-11-26

> **Status (2026-11-26): first version built** from articles and selections, with the browser voice (A1) and
> plan-based daily minutes (A2). Not yet: Notebook-concept and Aha Learning sources, the server voice, offline audio.
> Listening progress lives on `AudioPart` (a series has one owner), and an `AudioUsage` ledger counts minutes.

### The idea
Everything you can read in AhaReading, you can also **listen to**: walking, driving, cooking, eyes closed. Audio is
**written for the ear**, not text read aloud. You choose the level, the style and how long each part is. Every part
is saved, so you can go back to any earlier session and pick up where you left off.

### What the user sees
1. **Listen** is on every article, selection, Aha Learning topic and set of Notebook concepts. It opens a short
   setup:
   - **Level:** Foundations, Working knowledge or Advanced.
   - **Style** (pick one; each part can use a different style):

     | Style | What it sounds like |
     |---|---|
     | **Build it from the ground up** | Starts from first principles; each idea rests on the last |
     | **Quick summary** | The main points in plain words, with a recap at the end |
     | **Key concepts** | One concept per chapter: what it is, why it matters, one example |
     | **Stories and fun facts** | History, people, surprising facts and real failures that make it stick |
     | **Real-world case** | A worked scenario ("a retailer's nightly load fails…") |
     | **Two voices** | A host asks, an expert explains; questions are a listener's natural ones |
     | **Common mistakes** | Misconceptions and why they're wrong |
     | **Quiz by ear** | A question, "pause and think", then the answer and why |

   - **Part length:** 2, 5, 10 or 15 minutes, or a custom length. Longer material is split into parts of that length.
   - **Voice and speed:** speed 0.75×–2×, changeable any time.
2. **Player** (works without looking):
   - **Controls:** play/pause, back 15 s, forward 30 s, previous/next chapter, previous/next part.
   - **Lock screen and headphones:** lock-screen and headphone-button controls (Media Session API).
   - **Continuous listening:** the next part plays automatically, and there's a sleep timer.
   - **Spoken cues:** "Part 2 of 4: Partitioning, about 5 minutes" at the start; a 20-second recap at the end.
3. **Library → Listening:** every series and part, with progress ("Part 3 of 6, 2:10 left"). Tap to resume exactly
   where you stopped. History is kept, so earlier sessions are always one tap away.
4. **Transcript:** each part has a synced transcript (for review, accessibility and search). It's optional, never
   required.

### Writing for the ear (the generation rules)
- **Plain spoken language:** short sentences, signposting ("There are three ideas here. First…"), and key terms
  repeated, not referred back to.
- **Nothing visual, ever:**
  - code is described ("a query that groups sales by month"), never read symbol by symbol;
  - tables become comparisons ("Postgres is row-based, while a warehouse like…");
  - numbers and abbreviations are spoken naturally;
  - no "see below" or "in the table".
- **Recaps and quizzes:** every part ends with a short recap. Quiz parts leave a 3–5 second pause before the answer.
- **Grounding:** the source text (article, selection, topic) is fenced as untrusted data. The script must stay within
  its material and the chosen style.
- **Length:** about 150 spoken words per minute, so a 5-minute part is about 750 words. The server checks length
  before making audio.

### How it works
- **Two steps:**
  1. The AI writes the script, in structured chapters, and the server checks it.
  2. A text-to-speech step turns it into audio.

  Parts are generated one at a time, when first played or prefetched one part ahead, so nothing is paid for until
  it's used.
- **Audio storage:** audio files go in **object storage** (see §5.1: not in Postgres). They're served through
  short-lived signed links and are cacheable for offline listening. Postgres stores only metadata.
- **Text-to-speech options (decision A1):**
  - **(a)** the browser's built-in speech: free and instant, but the voice varies by device, there's no file, and on
    iPhone it stops when the screen locks;
  - **(b)** a server speech service (for example OpenAI or Google Cloud TTS): natural voices, a real audio file,
    lock-screen playback, offline caching. Cost is roughly 1–2 cents per minute.
  - **Decision:** start with **(a)**, the browser's default voice. Speech goes through a provider interface
    (`speak`, `pause`, `resume`, `stop`, progress events), so a server service can be added later as another provider.
- **Data:**
  - `AudioSeries`: `id, userId, source (articleId | selection quote | planTopicId | conceptIds), level, style, partMinutes, voice, createdAt`.
  - `AudioPart`: `id, seriesId, order, title, scriptMd, chapters JSON [{title, startSec}], audioKey, durationSec, status`.
  - `ListeningProgress`: `userId, partId, positionSec, speed, completedAt`.
- **Limits:** a daily cap on generated audio minutes (for example 60), and parts at most 15 minutes. Speech is
  generated only from a script that passed the checks.

### More ideas in the same spirit
- **Daily audio review:** your due Notebook concepts as a 5-minute "listen and recall" episode (question, pause,
  answer).
- **Article as a podcast:** a one-tap "Two voices" episode for any saved article.
- **Explain it back:** after listening, say or type the idea in your own words, and the AI tells you what you got
  right and what you missed (the Feynman technique).

## 3B. The bigger goal: many ways into the same idea

**Goal:** *AhaReading meets the learner where they are: any **mode**, any **depth**, any **angle**, any **amount of
time**, and turns what they read into what they know.* The same piece of knowledge should be reachable in whichever
form suits the moment, and each form should strengthen the others.

| Dimension | Options (✅ built, 🔜 designed, 💡 idea) |
|---|---|
| **Mode** | Read ✅ · See (diagrams 🔜, concept maps 💡, timelines 💡) · Listen 🔜 · Do (exercises, SQL sandbox 🔜) · Talk (explain it back 💡, Socratic chat on the article 💡) |
| **Depth** | Simple / Analogy / Deep dive ✅ · Go deeper ✅ · Foundations → Advanced learning paths 🔜 |
| **Angle** | Bigger picture ✅ · Related topics ✅ · Ground-up, summary, stories, case study, common mistakes 🔜 · History and people 💡 · Contrarian view ("when this is the wrong choice") 💡 |
| **Time** | 2-minute micro-lessons 💡 · 5–15 minute audio parts 🔜 · Deep sessions ✅ · Commute mode (audio queue) 💡 |
| **Memory** | Spaced review ✅ · Missed exercises into review 🔜 · Audio review 💡 · Cross-mode review (see it, then hear it, then do it) 💡 |
| **Personal** | Learner profile (role, goal, what you already know) shaping examples 💡 · Adaptive difficulty from exercise results 🔜 · Knowledge map of strengths and gaps 💡 |
| **Connections** | "You met this in article X" cross-links 💡 · Prerequisite check before reading ("you'll need joins and grain") 💡 · Auto-built glossary per article 💡 |
| **Reflection** | Weekly recap ("your week in learning", as text or audio) 💡 · Streaks ✅ · Explain-it-back score over time 💡 |

**Suggested next ideas after the current plan (highest value first):**
1. **Explain it back.** It turns passive reading into active recall and reuses the existing AI safety pipeline.
2. **Prerequisite check.** Before a hard article, list the 3–5 concepts it assumes, with one-tap explanations.
3. **Learner profile.** Every explanation, diagram, lesson and audio part uses examples from your field.
4. **Concept map.** A diagram of how your Notebook concepts connect across articles; it reuses the diagram renderer.

## 4. Build order and effort

| Phase | What | Rough effort | Depends on |
|---|---|---|---|
| 1 | Markdown reading format (storage, renderer, Highlight API marks, converters, editor preview, migration) | 2–3 sessions | — |
| 2 | Diagrams (prompt + validation, layout + zoom, retries, saving) | 2 sessions | 1 (selection over formatted text) |
| 3a | Aha Learning core: topic suggestions, plans, lessons, multiple choice, find the error, short answer, progress, Review link | 3 sessions | 1 (Markdown lessons) |
| 3b | Write-your-own-SQL: in-browser engine, practice datasets, result comparison, broken-exercise check | 2 sessions | 3a |
| 4 | Aha Listening (scripts for the ear, speech, player with lock-screen controls, history and resume, part length) | 3 sessions | 3a for learning topics; works on articles from day one |

Each phase ends with the same routine as before: a QA agent, an AI-engineer prompt review (phases 2 and 3), a lead
engineer review, and the full test suites. Each phase ships on its own.

---

## 5. Decisions (approved 2026-11-26: the recommended default for each)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Images in articles | (a) show the alt text with "open image" (no remote loading); (b) load remote images directly (needs a looser security policy and lets image hosts track readers); (c) proxy images through our server | **(a) now**, (c) later if images matter |
| D2 | Pasted text | (a) auto-detect Markdown, with a toggle; (b) always plain; (c) always Markdown | **(a)** |
| D3 | Retry limit scope | (a) 3 retries per selection, ever; (b) 3 per selection per day | **(a)**, plus the daily AI quota |
| D4 | SQL engine for exercises | (a) DuckDB-WASM: warehouse-style SQL (window functions, CTEs, `QUALIFY`), loaded only on SQL exercises, about 7 MB; (b) SQLite (sql.js): about 1 MB, fewer analytic features | **(a)** for data-warehouse learners |
| D5 | Where SQL answers are checked | (a) in the browser: simple, but a curious user could find the expected result with developer tools; (b) on the server with DuckDB: tamper-proof, but adds a native package to the Railway build | **(a)**: it's self-study, and "Show solution" exists anyway |
| D6 | Daily cap on generated lessons | 10 / 20 / 50 per user per day | **20** |
| D7 | Where Aha Learning lives | (a) a new **Learn** tab (Read · Learn · Notebook · Review · Settings); (b) inside the Notebook | **(a)** |
| A1 | Speech for Aha Listening | (a) the browser's built-in speech; (b) a server speech service with real audio files | **Decided: (a) first**, behind a speech-provider interface so a server service (b) can be added later without changing the player or the scripts |
| A2 | Daily audio cap | 30 / 60 / 120 generated minutes per user per day | **Decided: 240 for admins, 60 for everyone else**, set by environment variables (`AUDIO_DAILY_MINUTES_ADMIN`, `AUDIO_DAILY_MINUTES_USER`) through an entitlements module, so payment plans can set their own limits later |
