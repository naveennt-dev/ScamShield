import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Authenticate | ScamShield",
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
