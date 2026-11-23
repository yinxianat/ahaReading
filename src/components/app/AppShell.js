"use client";
/**
 * Signed-in app chrome: nav, offline banner, due count. The reader route
 * hides the tab bar so its selection action bar owns the thumb zone.
 */
import { usePathname } from "next/navigation";
import { TabBar, Sidebar } from "./Nav.js";
import OfflineBanner from "./OfflineBanner.js";
import { DueProvider } from "./DueContext.js";
import ErrorBoundary from "@/components/ErrorBoundary.js";

export default function AppShell({ children }) {
  const pathname = usePathname();
  const reader = /^\/read\/[^/]+/.test(pathname);
  return (
    <DueProvider>
      {reader ? null : <Sidebar />}
      <div className={reader ? "" : "lg:pl-[232px]"}>
        <OfflineBanner />
        <ErrorBoundary name="app">{children}</ErrorBoundary>
      </div>
      {reader ? null : <TabBar />}
    </DueProvider>
  );
}
