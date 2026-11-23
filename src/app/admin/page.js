import AdminPortal from "@/components/admin/AdminPortal.js";

const TABS = ["overview", "ai-calls", "errors", "users", "infrastructure"];

export default async function AdminPage({ searchParams }) {
  const p = await searchParams;
  const tab = TABS.includes(p?.tab) ? p.tab : "overview";
  return <AdminPortal initialTab={tab} />;
}
