import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { ScanUrl } from "@/components/scan/ScanUrl";

export const metadata: Metadata = { title: "Scan URL" };

export default function Page() {
  return (
    <>
      <PageHeader title="Scan URL" description="Check a link before you open it. We analyse it without you having to visit it." />
      <ScanUrl />
    </>
  );
}
