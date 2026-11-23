import AuthGuard from "@/components/app/AuthGuard.js";

export const metadata = { title: "Welcome", robots: { index: false } };

export default function OnboardingLayout({ children }) {
  return <AuthGuard requireOnboarded={false}>{children}</AuthGuard>;
}
