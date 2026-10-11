import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { ReportsView } from "@/components/views/ReportsView";

export const metadata: Metadata = { title: "Scam Reports" };

export default function Page() {
  return (
    <>
      <PageHeader title="Scam Reports" description="Reports are reviewed signals, not automatic verdicts. Your identity is never shared." />
      <ReportsView />
    </>
  );
}
