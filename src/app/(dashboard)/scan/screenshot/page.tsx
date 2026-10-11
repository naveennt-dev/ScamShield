import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { ScanScreenshot } from "@/components/scan/ScanScreenshot";

export const metadata: Metadata = { title: "Scan Screenshot" };

export default function Page() {
  return (
    <>
      <PageHeader title="Scan Screenshot" description="Upload a screenshot of a message; we read the text and check it for scams." />
      <ScanScreenshot />
    </>
  );
}
