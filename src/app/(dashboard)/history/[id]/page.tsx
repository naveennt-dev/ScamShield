import type { Metadata } from "next";
import { HistoryDetailView } from "@/components/views/HistoryDetailView";

export const metadata: Metadata = { title: "Scan details" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <HistoryDetailView id={id} />;
}
