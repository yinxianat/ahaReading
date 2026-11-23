import AuthCard from "@/components/auth/AuthCard.js";
import VerifyClient from "@/components/auth/VerifyClient.js";
import { sanitizeNext } from "@/lib/client/next-path.js";

export const metadata = { title: "Signing you in", referrer: "no-referrer" };

export default async function VerifyPage({ searchParams }) {
  const params = await searchParams;
  const next = sanitizeNext(typeof params?.next === "string" ? params.next : "", "");
  return (
    <AuthCard>
      <VerifyClient next={next} />
    </AuthCard>
  );
}
