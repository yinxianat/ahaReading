"use client";
/**
 * Registers /sw.js in production only (or with localStorage aha.sw = "1" for
 * testing in dev), so dev builds never serve stale bundles from a cache.
 */
import { useEffect } from "react";
import { captureInstallPrompt } from "@/lib/client/install.js";

captureInstallPrompt();

export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let forced = false;
    try {
      forced = localStorage.getItem("aha.sw") === "1";
    } catch {
      forced = false;
    }
    if (process.env.NODE_ENV !== "production" && !forced) return;
    const register = () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
