import type { Metadata } from "next";
import { PageHeader } from "@/components/app/PageHeader";
import { SettingsView } from "@/components/views/SettingsView";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return (
    <>
      <PageHeader title="Settings" description="Control what ScamShield stores and which analysers it uses." />
      <SettingsView />
    </>
  );
}
