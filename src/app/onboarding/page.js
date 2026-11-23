import Onboarding from "@/components/onboarding/Onboarding.js";
import { sanitizeNext } from "@/lib/client/next-path.js";

export default async function OnboardingPage({ searchParams }) {
  const params = await searchParams;
  const next = sanitizeNext(typeof params?.next === "string" ? params.next : "", "/read");
  return <Onboarding next={next.startsWith("/onboarding") ? "/read" : next} />;
}
