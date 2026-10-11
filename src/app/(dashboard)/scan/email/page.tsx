import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { ScanEmail } from "@/components/scan/ScanEmail";

export const metadata: Metadata = { title: "Scan Email" };

export default function Page() {
  return (
    <>
      <PageHeader title="Scan Email" description="Check the sender, wording, links and attachment names of a suspicious email." />
      <ScanEmail />
    </>
  );
}
