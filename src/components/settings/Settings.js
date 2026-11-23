"use client";
/**
 * Settings (UX-SPEC 7): profile, reading preferences, install, admin link,
 * sign out, delete account.
 */
import { useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/client/api.js";
import { getQueue } from "@/lib/client/offline-queue.js";
import { getInstallPrompt, installContext, subscribeInstallPrompt } from "@/lib/client/install.js";
import { clearLocalUserData } from "@/lib/client/local-data.js";
import { useUser } from "@/components/app/UserContext.js";
import TopBar from "@/components/app/TopBar.js";
import Button from "@/components/ui/Button.js";
import { Segmented } from "@/components/ui/Tabs.js";
import { TextField } from "@/components/ui/Field.js";
import Dialog from "@/components/ui/Dialog.js";
import Sheet from "@/components/ui/Sheet.js";
import ErrorAlert from "@/components/ui/ErrorAlert.js";
import Icon from "@/components/ui/icons.js";
import Link from "next/link";

const VERSION = "0.1.0";

function Group({ title, children }) {
  return (
    <section className="mb-6" aria-labelledby={`g-${title}`}>
      <h2 id={`g-${title}`} className="mb-2 px-1 text-[12px] font-semibold tracking-[.04em] text-muted uppercase">
        {title}
      </h2>
      <div className="divide-y divide-border rounded-md border border-border bg-surface">{children}</div>
    </section>
  );
}

function Row({ children, className = "" }) {
  return <div className={`min-h-[52px] px-4 py-3 ${className}`}>{children}</div>;
}

function PrefRow({ label, helper, field, options, user, setUser }) {
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);
  const value = pending ?? user[field];
  const save = async (v) => {
    setPending(v);
    setError(null);
    try {
      const data = await api("/api/me", { method: "PATCH", body: { [field]: v }, timeoutMs: 15000 });
      if (data?.user) setUser(data.user);
      else setUser({ ...user, [field]: v });
      setPending(null);
    } catch (err) {
      setPending(null);
      setError({ err, v });
    }
  };
  return (
    <Row>
      <p className="mb-2 font-semibold">{label}</p>
      <Segmented ariaLabel={label} options={options} value={value} onChange={save} className="w-full" />
      {helper ? <p className="mt-2 text-[14px] text-muted">{helper}</p> : null}
      {error ? <ErrorAlert className="mt-3" compact error={error.err} context="settings" onRetry={() => save(error.v)} onDismiss={() => setError(null)} /> : null}
    </Row>
  );
}

function NameRow({ user, setUser }) {
  const [name, setName] = useState(user.displayName || "");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const save = async () => {
    const value = name.trim();
    if (value === (user.displayName || "")) return;
    setStatus("saving");
    setError(null);
    try {
      const data = await api("/api/me", { method: "PATCH", body: { displayName: value }, timeoutMs: 15000 });
      setUser(data?.user || { ...user, displayName: value });
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      setStatus("idle");
      if (err.code === "invalid_input") setError({ field: err.message || "Use up to 100 characters." });
      else setError({ err });
    }
  };
  return (
    <Row>
      <TextField
        label="Display name"
        value={name}
        maxLength={100}
        autoComplete="name"
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
        error={error?.field}
        helper={status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : undefined}
      />
      {error?.err ? <ErrorAlert className="mt-3" compact error={error.err} context="settings" onRetry={save} onDismiss={() => setError(null)} /> : null}
    </Row>
  );
}

function InstallRow() {
  const [open, setOpen] = useState(false);
  const prompt = useSyncExternalStore(subscribeInstallPrompt, getInstallPrompt, () => null);
  const context = useSyncExternalStore(() => () => {}, installContext, () => "other");
  if (context === "standalone") {
    return (
      <Row className="flex items-center justify-between">
        <span className="font-semibold">Install AhaReading</span>
        <span className="text-success">Installed ✓</span>
      </Row>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex min-h-[52px] w-full items-center justify-between px-4 text-left font-semibold">
        Install AhaReading
        <Icon name="chevronRight" size={20} className="text-muted" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Install AhaReading" snapPoints={[0.6, 0.92]}>
        {context === "ios" ? (
          <div className="space-y-3 pt-2">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Tap the <strong>Share</strong> button (square with an arrow) at the bottom of Safari.
              </li>
              <li>
                Scroll and tap <strong>Add to Home Screen</strong>.
              </li>
              <li>
                Tap <strong>Add</strong>.
              </li>
            </ol>
            <p className="text-[14px] text-muted">On iPhone, this only works in Safari.</p>
            <p className="text-[14px] text-muted">
              The installed app signs in separately from Safari. Open it, sign in with your email, and type the 6-digit code from the email — the link
              would open in Safari instead.
            </p>
          </div>
        ) : prompt ? (
          <div className="pt-2">
            <p className="mb-4 text-muted">Add AhaReading to your device so it opens like an app — and your Notebook and Review work offline.</p>
            <Button
              icon="download"
              onClick={async () => {
                prompt.prompt();
                try {
                  await prompt.userChoice;
                } finally {
                  setOpen(false);
                }
              }}
            >
              Install app
            </Button>
          </div>
        ) : (
          <p className="pt-2">
            Use your browser&apos;s menu and choose <strong>Install</strong> or <strong>Add to Home Screen</strong>.
          </p>
        )}
      </Sheet>
    </>
  );
}

function AccountRows() {
  // null | "this" | "all": which sign-out is running (or failed), so only that button spins.
  const [signingOut, setSigningOut] = useState(null);
  const [signOutError, setSignOutError] = useState(null);
  const [queueWarn, setQueueWarn] = useState(0);
  const [warnEverywhere, setWarnEverywhere] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const stayRef = useRef(null);
  const cancelRef = useRef(null);

  /**
   * @param {boolean} force skip the unsynced-reviews warning
   * @param {boolean} everywhere also end every other device's session (SEC-10)
   */
  const signOut = async (force = false, everywhere = false) => {
    const pendingReviews = getQueue().length;
    if (!force && pendingReviews > 0) {
      setWarnEverywhere(everywhere);
      setQueueWarn(pendingReviews);
      return;
    }
    setQueueWarn(0);
    setSigningOut(everywhere ? "all" : "this");
    setSignOutError(null);
    try {
      await api(everywhere ? "/api/auth/logout-all" : "/api/auth/logout", { method: "POST", timeoutMs: 15000, redirectOn401: false });
    } catch (err) {
      // Already signed out here; for "everywhere" that means this session was
      // revoked already, so the other devices' sessions are gone too.
      if (err.code !== "unauthenticated") {
        setSigningOut(null);
        setSignOutError({ err, everywhere });
        return;
      }
    }
    await clearLocalUserData();
    window.location.replace("/login");
  };

  const deleteAccount = async () => {
    if (confirmText !== "DELETE") return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api("/api/me", { method: "DELETE", body: { confirm: "DELETE" }, timeoutMs: 20000 });
      await clearLocalUserData();
      window.location.replace("/");
    } catch (err) {
      setDeleting(false);
      setDeleteError(err);
    }
  };

  return (
    <>
      <Row>
        <Button variant="secondary" fullWidth loading={signingOut === "this"} loadingLabel="Signing out…" disabled={Boolean(signingOut)} onClick={() => signOut(false)}>
          Sign out
        </Button>
        <Button variant="text" fullWidth className="mt-2" loading={signingOut === "all"} loadingLabel="Signing out everywhere…" disabled={Boolean(signingOut)} onClick={() => signOut(false, true)}>
          Sign out of all devices
        </Button>
        <p className="mt-1 text-center text-[13px] text-muted">Use this if you signed in on a phone or computer you no longer use.</p>
        {signOutError ? (
          <ErrorAlert
            className="mt-3"
            compact
            error={signOutError.err}
            context="form"
            onRetry={() => signOut(true, signOutError.everywhere)}
            onDismiss={() => setSignOutError(null)}
          />
        ) : null}
      </Row>
      <Row>
        <Button
          variant="danger-text"
          fullWidth
          onClick={() => {
            setConfirmText("");
            setDeleteError(null);
            setDeleteOpen(true);
          }}
        >
          Delete account
        </Button>
      </Row>

      <Dialog
        open={queueWarn > 0}
        onClose={() => setQueueWarn(0)}
        title={queueWarn === 1 ? "1 review hasn't synced yet. Sign out anyway?" : `${queueWarn} reviews haven't synced yet. Sign out anyway?`}
        description={warnEverywhere ? "Signing out deletes them from this device. Other devices are signed out too." : "Signing out deletes them from this device."}
        initialFocusRef={stayRef}
        actions={
          <>
            <Button ref={stayRef} variant="secondary" onClick={() => setQueueWarn(0)}>
              Stay signed in
            </Button>
            <Button variant="danger" onClick={() => signOut(true, warnEverywhere)}>
              {warnEverywhere ? "Sign out everywhere" : "Sign out"}
            </Button>
          </>
        }
      />

      <Dialog
        open={deleteOpen}
        onClose={() => !deleting && setDeleteOpen(false)}
        title="Delete your account?"
        description="This permanently deletes your articles, Notebook, and review history. This can't be undone."
        initialFocusRef={cancelRef}
        actions={
          <>
            <Button ref={cancelRef} variant="secondary" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" disabled={confirmText !== "DELETE"} loading={deleting} loadingLabel="Deleting…" onClick={deleteAccount}>
              Delete account
            </Button>
          </>
        }
      >
        <TextField
          label="Type DELETE to confirm"
          value={confirmText}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setConfirmText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              deleteAccount();
            }
          }}
        />
        {deleteError ? <ErrorAlert className="mt-3" compact error={deleteError} context="form" onRetry={deleteAccount} /> : null}
      </Dialog>
    </>
  );
}

export default function Settings() {
  const { user, setUser } = useUser();
  if (!user) return null;
  return (
    <main id="main" className="app-main mx-auto max-w-[720px] px-4 md:px-6">
      <TopBar title="Settings" />
      <Group title="Profile">
        <NameRow user={user} setUser={setUser} />
        <Row>
          <p className="text-[14px] font-semibold">Email</p>
          <p className="text-muted break-anywhere">{user.email}</p>
        </Row>
      </Group>
      <Group title="Reading">
        <PrefRow
          label="Explanations / 解释语言"
          field="locale"
          user={user}
          setUser={setUser}
          options={[
            { value: "en", label: "English" },
            { value: "zh", label: <span>English + <span lang="zh-Hans">中文</span></span>, ariaLabel: "English + 中文" },
          ]}
        />
        <PrefRow
          label="Start explanations at"
          helper="You can always change level while reading."
          field="helpLevel"
          user={user}
          setUser={setUser}
          options={[
            { value: 1, label: "1 Simple" },
            { value: 2, label: "2 Analogy" },
            { value: 3, label: "3 Deep dive" },
          ]}
        />
      </Group>
      <Group title="App">
        <InstallRow />
        {user.isAdmin ? (
          <Link href="/admin" className="flex min-h-[52px] items-center justify-between px-4 font-semibold text-text no-underline">
            Admin portal
            <Icon name="chevronRight" size={20} className="text-muted" />
          </Link>
        ) : null}
      </Group>
      <Group title="Account">
        <AccountRows />
      </Group>
      <p className="pb-4 text-center text-[12px] text-muted">AhaReading {VERSION}</p>
    </main>
  );
}
