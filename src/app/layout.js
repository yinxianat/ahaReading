import { Source_Serif_4 } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ui/Toast.js";
import ServiceWorkerRegistrar from "@/components/app/ServiceWorker.js";

// Self-hosted at build time (CSP font-src 'self'); only the reading surfaces use it.
const readingFont = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-reading",
  fallback: ["Georgia", "Songti SC", "serif"],
});

export const metadata = {
  title: { default: "AhaReading — understand every sentence you read", template: "%s · AhaReading" },
  description:
    "AhaReading is an AI reading tutor. Select the part of an article that loses you and get it explained simply, then with an analogy, then in depth. Save what clicks and review it before you forget.",
  applicationName: "AhaReading",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // iOS ignores SVG/manifest icons for the home screen; it needs this PNG.
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "AhaReading", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  other: { "mobile-web-app-capable": "yes" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAF9F6" },
    { media: "(prefers-color-scheme: dark)", color: "#121316" },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={readingFont.variable}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <ToastProvider>{children}</ToastProvider>
        <div id="live-status" className="sr-only" aria-live="polite" role="status" />
        <div id="live-alert" className="sr-only" aria-live="assertive" role="alert" />
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
