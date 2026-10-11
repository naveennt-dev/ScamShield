import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Poppins } from "next/font/google";
import { headers } from "next/headers";
import { QueryClientProviderWrapper } from "@/providers/QueryClient";
import { Toaster } from "sonner";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: { default: "ScamShield — Scam detection", template: "%s | ScamShield" },
  description:
    "ScamShield checks suspicious messages, links, screenshots and emails for scams using rules, machine learning, link analysis and AI, and explains what to do next.",
  keywords: ["ScamShield", "scam detection", "phishing", "UPI fraud", "KYC scam", "fraud prevention"],
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b4f8a",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Reading the nonce makes every page dynamic so Next.js can attach the per-request CSP nonce.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en">
      <body className={`${poppins.className} antialiased bg-slate-50 text-slate-900`} nonce={nonce}>
        <QueryClientProviderWrapper>
          {children}
          <Toaster richColors position="top-center" />
        </QueryClientProviderWrapper>
      </body>
    </html>
  );
}
