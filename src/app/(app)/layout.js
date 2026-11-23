import AuthGuard from "@/components/app/AuthGuard.js";
import AppShell from "@/components/app/AppShell.js";

export const metadata = { robots: { index: false } };

export default function AppLayout({ children }) {
  return (
    <AuthGuard>
      <AppShell>{children}</AppShell>
    </AuthGuard>
  );
}
