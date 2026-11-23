// Sign-in, verify, redirects, session expiry, logout, admin gate.
import { test, expect, sql, addSession, isMobile } from "./support/fixtures.mjs";
import { createUser, mintLoginToken, BASE } from "./support/db.mjs";

test("landing page is server-rendered with the product copy", async ({ request }) => {
  const res = await request.get("/", { headers: { cookie: "" } });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain("AhaReading");
  expect(html).toContain("Understand every sentence you read.");
  expect(html).toContain("Get started");
});

test("signed-in visitor to / is redirected to /read", async ({ page, user }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/read$/);
});

test.describe("login form validation", () => {
  test("names the fix for bad emails and offers typo correction", async ({ page }) => {
    let sends = 0;
    page.on("request", (r) => r.url().endsWith("/api/auth/request-link") && sends++);
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to AhaReading" })).toBeVisible();
    const email = page.getByLabel("Email");
    const submit = page.getByRole("button", { name: "Email me a sign-in link" });
    await submit.click();
    await expect(page.getByText("Enter your email address.")).toBeVisible();
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await email.fill("alice.example.com");
    await submit.click();
    await expect(page.getByText(/Add an @ — for example you@example.com/)).toBeVisible();
    await email.fill("@example.com");
    await submit.click();
    await expect(page.getByText(/Add the part before the @/)).toBeVisible();
    await email.fill("a@b@example.com");
    await submit.click();
    await expect(page.getByText(/only one @/)).toBeVisible();
    await email.fill("alice@example");
    await submit.click();
    await expect(page.getByText("The part after @ needs a dot, like gmail.com")).toBeVisible();
    await email.fill("ali ce@example.com");
    await submit.click();
    await expect(page.getByText(/Remove the space from your email/)).toBeVisible();
    await email.fill("alice@gmial.com");
    await submit.click();
    await expect(page.getByText("Did you mean")).toBeVisible();
    await expect(page.getByRole("button", { name: "Yes, use gmail.com" })).toBeVisible();
    await expect(page.getByRole("button", { name: "No, send to gmial.com" })).toBeVisible();
    expect(sends).toBe(0);
  });

  test("reason=expired shows the session-ended notice", async ({ page }) => {
    await page.goto("/login?reason=expired&next=%2Fnotebook");
    await expect(page.getByText("Your session ended. Sign in again to pick up where you left off.")).toBeVisible();
  });
});

// The only tests that spend the real request-link quota (5 / 15 min / IP).
test.describe("request link + check email + dev link", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "spends the shared request-link quota; desktop only");
  });

  test("[QA-6] check-your-email screen, resend countdown, change email, dev link signs in and honours next", async ({ page }) => {
    const addr = `qa-login-${Date.now()}@example.test`;
    await page.goto("/login?next=%2Fnotebook");
    await page.getByLabel("Email").fill(addr);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByText(`We sent a sign-in link to ${addr}`)).toBeVisible();
    await expect(page.getByText("The link works for 15 minutes.")).toBeVisible();
    const resend = page.getByRole("button", { name: /Resend in \d+s/ });
    await expect(resend).toBeDisabled();
    const devLink = await page.getByTestId("dev-link").getAttribute("href");
    expect(devLink).toMatch(/\/auth\/verify\?token=[a-f0-9]{64}&next=%2Fnotebook$/);
    // Change email returns to the form, prefilled.
    await page.getByRole("button", { name: "Use a different email" }).click();
    await expect(page.getByLabel("Email")).toHaveValue(addr);
    // Verify: new user → onboarding with next preserved → skip → /notebook.
    await page.goto(devLink);
    await expect(page).toHaveURL(/\/onboarding\?next=%2Fnotebook/);
    expect(page.url()).not.toContain("token=");
    await page.getByRole("button", { name: "Skip", exact: true }).or(page.getByRole("link", { name: "Skip", exact: true })).first().click();
    await expect(page).toHaveURL(/\/notebook$/);
    // Reusing the link → link_used.
    await page.goto(devLink);
    await expect(page.getByRole("heading", { name: "This link was already used" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Send a new link" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to Library" })).toBeVisible();
  });
});

test.describe("verify page", () => {
  test("garbage token → link_invalid with recovery", async ({ page }) => {
    await page.goto("/auth/verify?token=nottoken");
    await expect(page.getByRole("heading", { name: "This link isn't valid" })).toBeVisible();
    await page.getByRole("link", { name: "Send a new link" }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("no token → link_invalid", async ({ page }) => {
    await page.goto("/auth/verify");
    await expect(page.getByRole("heading", { name: "This link isn't valid" })).toBeVisible();
  });

  test("expired token → link_expired", async ({ page }) => {
    const token = await mintLoginToken(`qa-exp-${Date.now()}@example.test`, { expiresInMs: -60_000 });
    await page.goto(`/auth/verify?token=${token}`);
    await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
    await expect(page.getByText("Sign-in links work for 15 minutes.")).toBeVisible();
  });

  test("[QA-6] valid token for an onboarded user goes straight to next", async ({ page }) => {
    const u = await createUser();
    const token = await mintLoginToken(u.email);
    await page.goto(`/auth/verify?token=${token}&next=%2Freview`);
    await expect(page).toHaveURL(/\/review$/);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  });

  test("hostile next values fall back to /read", async ({ page }) => {
    const u = await createUser();
    const token = await mintLoginToken(u.email);
    await page.goto(`/auth/verify?token=${token}&next=${encodeURIComponent("//evil.example/x")}`);
    await expect(page).toHaveURL(/localhost:3100\/read$/);
  });
});

test.describe("protected routes and session", () => {
  for (const path of ["/read", "/notebook", "/review", "/settings", "/onboarding", "/admin"]) {
    test(`signed out ${path} → /login?next=`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    });
  }

  test("cookie deleted mid-session → next API call sends to login with notice and next", async ({ page, context, user }) => {
    await page.goto("/notebook");
    await expect(page.getByRole("heading", { name: "Notebook", exact: true })).toBeVisible();
    await context.clearCookies();
    await page.getByPlaceholder("Search terms and explanations").fill("anything");
    await expect(page).toHaveURL(/\/login\?next=%2Fnotebook.*reason=expired/);
    await expect(page.getByText("Your session ended.")).toBeVisible();
  });

  test("session expiry on full navigation also shows the notice", async ({ page, context, user }) => {
    await page.goto("/read");
    await expect(page.getByRole("heading", { name: "Read", exact: true })).toBeVisible();
    await context.clearCookies();
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings/);
    await expect(page.getByText("Your session ended.")).toBeVisible();
  });

  test("logout clears the session", async ({ page, user }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
    const res = await page.request.get("/api/auth/me");
    expect(res.status()).toBe(401);
    await page.goto("/read");
    await expect(page).toHaveURL(/\/login\?next=%2Fread/);
  });

  test("[SEC-10] sign out of all devices ends the other device's session too", async ({ page, user, browser }) => {
    // A second device: its own cookie jar holding a session for the same user.
    const other = await browser.newContext();
    await addSession(other, user.token);
    expect((await other.request.get(`${BASE}/api/auth/me`)).status()).toBe(200);

    await page.goto("/settings");
    await page.getByRole("button", { name: "Sign out of all devices" }).click();
    await expect(page).toHaveURL(/\/login/);
    expect((await page.request.get("/api/auth/me")).status()).toBe(401);
    const res = await other.request.get(`${BASE}/api/auth/me`);
    expect(res.status()).toBe(401);
    expect(res.headers()["set-cookie"] || "").toMatch(/aha_session=;/);
    await other.close();
  });
});

test.describe("admin", () => {
  test("non-admin sees the operator 403 page", async ({ page, user }) => {
    await page.goto("/admin");
    await expect(page.getByText("This area is for operators.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to reading" })).toBeVisible();
  });

  test("admin sees portal and every tab loads data", async ({ page, context, issues }) => {
    const [existing] = await sql(`SELECT id FROM "User" WHERE email='qa-admin@example.test'`);
    let token;
    if (existing) {
      const { SignJWT } = await import("jose");
      token = await new SignJWT({ email: "qa-admin@example.test" }).setProtectedHeader({ alg: "HS256" }).setSubject(existing.id).setIssuedAt().setExpirationTime("1d").sign(new TextEncoder().encode(process.env.JWT_SECRET));
    } else {
      token = (await createUser({ email: "qa-admin@example.test" })).token;
    }
    await addSession(context, token);
    // Generate some AI-call rows so the tables are non-empty.
    await page.request.post("/api/explain", { data: { highlightedText: "admin __refuse__", surroundingText: "ctx" } });
    await page.goto("/admin");
    await expect(page.getByText("AhaReading · Admin").or(page.getByText("Admin")).first()).toBeVisible();
    const tabs = ["Overview", "AI Calls", "Errors", "Users", "Infrastructure"];
    for (const name of tabs) {
      await page.getByRole("tab", { name }).click();
      await expect(page).toHaveURL(new RegExp(`tab=${name === "Overview" ? "overview" : name.toLowerCase().replace(" ", "-")}`));
      await page.waitForLoadState("networkidle");
      await expect(page.getByText(/Couldn't load|Something went wrong/)).toHaveCount(0);
    }
    await page.getByRole("tab", { name: "Users" }).click();
    await expect(page.getByRole("table")).toBeVisible();
    await page.getByRole("tab", { name: "AI Calls" }).click();
    await expect(page.getByText("refusal").first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole("tab", { name: "AI Calls" })).toHaveAttribute("aria-selected", "true");
    for (const p of ["overview", "logs", "ai-calls", "users", "diagnostics", "metrics"]) {
      const r = await page.request.get(`/api/admin/${p}`);
      expect(r.status(), p).toBe(200);
      const body = await r.text();
      expect(body, p).not.toMatch(/JWT_SECRET=|MAGIC_LINK_SECRET=|at .*\.js:\d+/);
    }
    expect(issues.filter((i) => !/favicon/.test(i))).toEqual([]);
  });
});
