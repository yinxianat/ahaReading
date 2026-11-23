"use client";
/**
 * Signed-in user for the client app. AuthGuard fills it from /api/auth/me;
 * the last good copy is kept in localStorage so the app still opens offline
 * (Notebook and Review work from the service-worker cache).
 */
import { createContext, useContext } from "react";

export const UserContext = createContext({ user: null, setUser: () => {}, offline: false });

/** @returns {{user:any, setUser:(u:any) => void, offline:boolean}} */
export function useUser() {
  return useContext(UserContext);
}

const KEY = "aha.user";

export function readCachedUser() {
  try {
    const u = JSON.parse(localStorage.getItem(KEY) || "null");
    return u && typeof u === "object" && u.id ? u : null;
  } catch {
    return null;
  }
}

export function writeCachedUser(user) {
  try {
    if (user) localStorage.setItem(KEY, JSON.stringify(user));
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: offline start just won't work
  }
}
