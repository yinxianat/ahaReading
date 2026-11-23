import { redirect } from "next/navigation";
import { hasValidSession } from "@/lib/session.js";
import { sanitizeNext } from "@/lib/client/next-path.js";
import LoginClient from "@/components/auth/LoginClient.js";
import AuthCard from "@/components/auth/AuthCard.js";

export const metadata = { title: "Sign in" };

// Query is read on the server and passed down, so the whole page server-renders
// (no useSearchParams in this tree — LESSONS 33).
export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  const next = sanitizeNext(typeof params?.next === "string" ? params.next : "", "");
  const reason = typeof params?.reason === "string" ? params.reason : "";
  // reason=expired means the app just got a 401: the cookie may still verify
  // (e.g. the account was deleted on another device), so redirecting back
  // would loop (PO-5). Show the form instead; signing in replaces the cookie.
  if (reason !== "expired" && (await hasValidSession())) redirect(next || "/read");
  return (
    <AuthCard>
      <LoginClient next={next} reason={reason} />
    </AuthCard>
  );
}
