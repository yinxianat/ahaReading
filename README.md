# AhaReading

**An AI reading tutor for technical articles.** You paste an article (or import it from a link), select a word or
phrase you don't understand, and AhaReading explains it in plain language. If the explanation still doesn't click,
you ask for more help and it explains again in a different way. Words you want to remember go into a personal
Notebook, and a short daily Review helps them stick.

It runs in a web browser on a laptop or a phone, and it can be installed on your phone's home screen like a regular app.

---

## Contents

1. [What it does](#what-it-does)
2. [How it is built](#how-it-is-built)
3. [Set it up on your computer](#set-it-up-on-your-computer)
4. [Use the app locally](#use-the-app-locally)
5. [Run the tests](#run-the-tests)
6. [Everyday commands](#everyday-commands)
7. [Project layout](#project-layout)
8. [Troubleshooting](#troubleshooting)
9. [Deployment](#deployment)
10. [Further reading: Project Guide](docs/PROJECT-GUIDE.md)

---

## What it does

| Feature | What you see |
|---|---|
| **Read** | Paste text, import an article from a web address, or upload a PDF or Word (.docx) file. Your articles are saved in a Library, where you can rename, edit or delete them. |
| **Explain, three levels** | Select text and tap *I don't understand*. Level 1 is a simple explanation. Level 2 uses an analogy or example. Level 3 is a detailed breakdown. You can move between levels at any time. |
| **Bookmarks & progress** | The app remembers where you stopped and offers to continue. Bookmark any passage to **re-visit later** or mark it **important**, with a note; find them all on the Bookmarks page. |
| **Chinese translation** | Any explanation can be translated into Mandarin Chinese. |
| **Notebook** | Save an explained word or phrase as a "concept", or write your own, with notes and tags. Search, filter, edit and delete them. |
| **Review** | Saved concepts come back as flashcards on a schedule. Concepts you remember easily come back less often, and ones you forget come back sooner. You can see your streak and how many concepts you have mastered. |
| **Works offline** | Saved concepts and reviews still work without internet. Reviews sync when you're back online. |
| **Sign-in without passwords** | You enter your email and get a sign-in link plus a 6-digit code. |
| **Admin portal** | For the operator: AI usage and cost, errors, users, and system health. |

AhaReading is deliberately **not a chatbot**. Every AI request has one job: explain *this* text, at *this* level.

> 📘 **Maintaining or changing the code?** Read the **[Project Guide](docs/PROJECT-GUIDE.md)**. It explains the
> design choices, every feature, the code structure, error handling, security and offline support, plus a playbook
> for common changes, without needing to read the code first.

---

## How it is built

You don't need to know these tools to run the project. Here is what each one is for:

| Tool | What it is | Its job in AhaReading |
|---|---|---|
| **Node.js** | A program that runs JavaScript outside the browser | Runs the app's server and all the developer tools |
| **npm** | Node's package manager (comes with Node.js) | Downloads the libraries the project needs, and runs commands like `npm run dev` |
| **Next.js** + **React** | A framework for building web apps | The web pages *and* the server behind them (the "API") |
| **PostgreSQL** ("Postgres") | A database | Stores users, articles, explanations, and Notebook concepts |
| **Prisma** | A database toolkit | Creates the database tables and lets the code read and write data |
| **Tailwind CSS** | A styling library | How the pages look |
| **AI providers** (Anthropic Claude, OpenAI, Google Gemini) | External AI services | Write the explanations. If one fails, the next one is tried. There is also a built-in **mock** provider that returns fake text, so you can develop without any AI account. |
| **Vitest** / **Playwright** | Testing tools | Vitest tests the code directly. Playwright drives a real browser to test the app end to end. |
| **Railway** | A hosting service | Where the production app runs |

---

## Set it up on your computer

These steps are written for **macOS**. On Windows or Linux the ideas are the same; follow the linked
installers instead of the Homebrew commands.

You run each command in a **terminal**. On a Mac, open the *Terminal* app (press ⌘ Space and type "Terminal").
Type or paste a command and press Enter. Lines starting with `#` are comments, so you don't need to type them.

### Step 1: Install Node.js (version 22 or newer)

The easiest way is **nvm**, a small tool that installs and switches Node versions.

```bash
# Install nvm (see https://github.com/nvm-sh/nvm for the latest command)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Close the terminal and open a new one, then run:

```bash
nvm install 22
node --version     # should print v22.something (or higher)
```

> Prefer a regular installer? Download the "LTS" version from <https://nodejs.org>.

### Step 2: Install PostgreSQL (the database)

With [Homebrew](https://brew.sh) (a package installer for macOS):

```bash
brew install postgresql@17
brew services start postgresql@17      # starts Postgres now and every time you log in
```

Check that it works:

```bash
psql -d postgres -c "select 1"
```

If you see a small table with `1` in it, Postgres is running. If the command isn't found, Homebrew will have
printed a line to add Postgres to your `PATH`; run that line, then open a new terminal.

> Windows or Linux: use the installer from <https://www.postgresql.org/download/>.
> Another easy option on a Mac is <https://postgresapp.com>.

### Step 3: Get the code and install its libraries

```bash
cd path/to/where/you/keep/projects
git clone <repository-url> AhaReading     # or copy the folder if you were given it directly
cd AhaReading
nvm use                                   # switches to the Node version in .nvmrc
npm install
```

`npm install` downloads everything the project depends on into a `node_modules` folder. It takes a minute or two,
and it also prepares the database code automatically.

### Step 4: Create the databases

The project uses separate databases so tests never touch your own data:

| Database | Used by |
|---|---|
| `ahareading` | The app when you run it yourself |
| `ahareading_test` | The automated tests (`npm test`) |
| `ahareading_qa` | The browser tests (`npm run test:e2e`), only needed if you run them |

```bash
createdb ahareading
createdb ahareading_test
createdb ahareading_qa
```

### Step 5: Create your settings file (`.env`)

The app reads its settings and secrets from a file called `.env` in the project folder. A template with every
setting explained is included:

```bash
cp .env.example .env
```

Open `.env` in any text editor and change these lines:

1. **Database addresses.** Replace `YOUR_DB_USER` with your computer username (run `whoami` to see it):
   ```
   DATABASE_URL="postgresql://YOUR_DB_USER@localhost:5432/ahareading"
   TEST_DATABASE_URL="postgresql://YOUR_DB_USER@localhost:5432/ahareading_test"
   ```
2. **Two secrets.** These are random strings the app uses to secure sign-ins. Generate each one with
   `openssl rand -hex 32` and paste the result in (use a *different* value for each):
   ```
   JWT_SECRET="…paste first value…"
   MAGIC_LINK_SECRET="…paste second value…"
   ```
   The app refuses to sign anyone in if these are missing or shorter than 32 characters.
3. **AI: start with the free mock.** You don't need an AI account to try the app. Set:
   ```
   AI_PROVIDER_CHAIN="mock"
   AI_MOCK="1"
   ```
   The mock writes placeholder explanations such as "Mock explanation (level 1)". To get real explanations, put
   at least one real key in `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GOOGLE_AI_API_KEY`, set
   `AI_PROVIDER_CHAIN="anthropic,openai,google"`, and clear `AI_MOCK`.
4. **Admin access (optional).** Put the email you'll sign in with here to see the admin portal:
   ```
   ADMIN_EMAILS="you@example.com"
   ```

Leave everything else as it is. Email (SMTP) is **not** needed locally; see [signing in](#signing-in-without-email).

> ⚠️ **Never share or commit `.env`.** It holds your secrets. It is already listed in `.gitignore`, and a
> safety check (`npm run check:secrets`) runs before every commit to catch secrets by accident.

### Step 6: Create the database tables

This creates all the tables in your `ahareading` database:

```bash
npm run db:deploy
```

Then do the same for the test databases:

```bash
DATABASE_URL="postgresql://$(whoami)@localhost:5432/ahareading_test" npm run db:deploy
DATABASE_URL="postgresql://$(whoami)@localhost:5432/ahareading_qa"   npm run db:deploy
```

Each should finish with "All migrations have been successfully applied."

### Step 7: Start the app

```bash
npm run dev
```

When you see `Ready`, open <http://localhost:3000> in your browser. Leave the terminal open while you use
the app, and press `Ctrl + C` in it to stop the app.

---

## Use the app locally

### Signing in without email

Locally, no email is actually sent. After you enter your email on the sign-in page, the "Check your email"
screen shows a **Dev sign-in link** and a **Dev code** at the bottom. Click the link (or type the code) to sign in.
The same link is also printed in the terminal where `npm run dev` is running.

### A quick tour

1. Sign in, and choose your language and starting help level.
2. On **Read**, paste a few paragraphs of any technical text (or upload a PDF or Word file) and open it.
3. Select a word or phrase, then tap **I don't understand**. Tap **Still confused?** to go up a level, and the
   **EN / 中文** switch for Chinese.
4. Tap **Save to Notebook** to keep the concept.
5. Open **Review** when concepts are due.
6. If your email is in `ADMIN_EMAILS`, visit <http://localhost:3000/admin>.

### Testing error messages with the mock AI

With the mock provider, put one of these markers inside the text you select to trigger a specific situation:

| Include in the selection | What happens |
|---|---|
| `__infra__` | The AI service "fails" (shows the *try again* message) |
| `__refuse__` | The AI "refuses" the content |
| `__garbage__` | The AI returns an unusable answer |
| `__slow__` | The answer takes 3 seconds |

---

## Run the tests

### Unit and API tests

```bash
npm test
```

These run in a few seconds against the `ahareading_test` database, and never touch your own data. They refuse to run if
`TEST_DATABASE_URL` is missing or points at the same database as `DATABASE_URL`.

### Browser (end-to-end) tests

These open real browsers (desktop Chrome, and an iPhone-sized Chrome and Safari engine) and click through the app.
First, download the browsers once:

```bash
npx playwright install
```

Then run:

```bash
npm run test:e2e
```

- The tests start their own copy of the app on port **3100**, using the `ahareading_qa` database and the mock AI.
- If your database username isn't the default, tell the tests where the QA database is:
  `QA_DATABASE_URL="postgresql://$(whoami)@localhost:5432/ahareading_qa" npm run test:e2e`
- If a test fails, look in `e2e/.results/` for screenshots, and run `npx playwright show-report e2e/.report` for a
  full report.
- They can run while your own `npm run dev` is running: the test server builds into its own folder (`.next-qa`)
  and has email (SMTP) switched off, so no real emails are sent.

### Code style check

```bash
npm run lint
```

---

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app for development at <http://localhost:3000> (reloads as you edit code) |
| `npm test` | Run the unit and API tests |
| `npm run test:e2e` | Run the browser tests |
| `npm run lint` | Check the code for common mistakes |
| `npm run build` then `npm run start` | Build and run the production version locally (stop `npm run dev` first: the build rewrites `.next` and the database client). To try a production build beside a running dev server, use `NEXT_DIST_DIR=.next-qa npx next build` and `NEXT_DIST_DIR=.next-qa npx next start -p 3200` |
| `npm run db:deploy` | Apply any new database changes |
| `npm run db:migrate` | *(Developers changing the database design)* Create a new database change after editing `prisma/schema.prisma` |
| `npm run check:secrets` | Scan the project for accidentally included passwords or keys |

---

## Project layout

```
AhaReading/
├── src/
│   ├── app/            Pages (each folder is a URL) and, under app/api/, the server API
│   ├── components/     Reusable pieces of the user interface (reader, notebook, review, settings, admin…)
│   ├── lib/            Shared logic: sign-in, AI providers, spaced repetition, rate limits, logging
│   │   ├── ai/         The AI provider chain (Anthropic, OpenAI, Google, mock)
│   │   └── client/     Code that runs in the browser (API calls, offline queue)
│   └── generated/      Database code created automatically by Prisma (don't edit)
├── prisma/
│   ├── schema.prisma   The database design: every table and column
│   └── migrations/     Step-by-step database changes, applied by `npm run db:deploy`
├── public/             Icons, the app manifest, and the offline service worker (sw.js)
├── tests/              Unit and API tests (Vitest)
├── e2e/                Browser tests (Playwright)
├── scripts/            Helper scripts (secret scanner, icon generator)
├── .env.example        Template for your settings, with an explanation of each one
└── railway.json        Deployment settings for Railway
```

---

## Troubleshooting

| Problem | What to do |
|---|---|
| `command not found: node` or `npm` | Node isn't installed or the terminal predates installing it. Open a new terminal and run `nvm use`. |
| `command not found: createdb` or `psql` | Postgres isn't on your `PATH`. Run `brew info postgresql@17` and follow its PATH instructions, then open a new terminal. |
| `Can't reach database server` / `connection refused` | Postgres isn't running. Run `brew services start postgresql@17`. |
| `role "YOUR_DB_USER" does not exist` | You didn't replace `YOUR_DB_USER` in `.env`. Use the output of `whoami`. |
| `database "ahareading" does not exist` | Run Step 4 (`createdb …`). |
| Errors mentioning a missing table or column | Run `npm run db:deploy` (and the two test-database versions in Step 6). |
| Sign-in fails, or `/api/health` says `weak_jwt_secret` | `JWT_SECRET` / `MAGIC_LINK_SECRET` are missing or too short. Regenerate them with `openssl rand -hex 32`. |
| "Our AI helper is temporarily unavailable" | No AI provider is set up. Use the mock (`AI_PROVIDER_CHAIN="mock"`, `AI_MOCK="1"`) or add a real API key. Restart `npm run dev` after changing `.env`. |
| `Port 3000 is in use` | Another copy of the app is running. Stop it with Ctrl + C in its terminal. |
| The page keeps reloading by itself (dev only) | The dev server's cache is stale. Stop it (Ctrl + C), delete the `.next/dev` folder, and run `npm run dev` again. |
| `Another next dev server is already running` | Same as above. Only one dev server can run in this folder (this also blocks the browser tests). |
| "Too many attempts" while signing in | Built-in protection against guessing. Wait for the timer, or restart `npm run dev` to reset it locally. |

To see what the server thinks of its own setup, open <http://localhost:3000/api/health>. It lists any problems by name.

---

## Deployment

Production runs on [Railway](https://railway.com) using `railway.json`. On each deploy, Railway builds the app
(`npm run build`), applies database changes (`prisma migrate deploy`), starts it (`npm run start`), and checks
`/api/health`. Production settings go in the Railway service's **Variables** tab, never in a file. Production needs:

- `DATABASE_URL`: provided automatically by Railway's Postgres.
- `JWT_SECRET`, `MAGIC_LINK_SECRET`: new values, different from your local ones.
- `BASE_URL`: the public address of the app (sign-in links are built from it).
- At least one AI key, plus `AI_PROVIDER_CHAIN`.
- `SMTP_*`: an email service, so sign-in emails are actually delivered.
- `ADMIN_EMAILS`.

The mock AI provider and the dev sign-in link are switched off automatically in production.
`.env.example` marks each setting as `[ALL]`, `[PROD]` or `[LOCAL ONLY]`.
