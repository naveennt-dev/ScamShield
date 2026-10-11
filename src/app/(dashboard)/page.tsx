import { PageHeader } from "@/components/app/PageHeader";
import { DashboardView } from "@/components/views/DashboardView";

export default function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" description="Check anything suspicious before you click, pay or reply." />
      <DashboardView />
    </>
  );
}
