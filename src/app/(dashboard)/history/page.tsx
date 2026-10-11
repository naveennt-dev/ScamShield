import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { HistoryView } from "@/components/views/HistoryView";

export const metadata: Metadata = { title: "History" };

export default function Page() {
  return (
    <>
      <PageHeader title="History" description="Your past scans. Only you can see them." />
      <HistoryView />
    </>
  );
}
