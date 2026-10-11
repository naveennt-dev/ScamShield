import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { ScanMessage } from "@/components/scan/ScanMessage";

export const metadata: Metadata = { title: "Scan Message" };

export default function Page() {
  return (
    <>
      <PageHeader title="Scan Message" description="Paste a suspicious SMS or chat message to see if it's a scam." />
      <ScanMessage />
    </>
  );
}
