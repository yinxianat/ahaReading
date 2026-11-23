import AuthGuard from "@/components/app/AuthGuard.js";

export const metadata = { title: "Admin", robots: { index: false } };

export default function AdminLayout({ children }) {
  return <AuthGuard requireOnboarded={false}>{children}</AuthGuard>;
}
