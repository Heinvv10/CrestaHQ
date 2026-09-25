import type { ReactNode } from "react";
import { SubAccountProvider } from "@/context/sub-account-context";
import { ContactsProvider } from "@/context/contacts-context";
import { BillingGuard } from "@/components/billing/billing-guard";

export default async function SubAccountLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ subAccountId: string }>;
}) {
  const { subAccountId } = await params;
  return (
    <SubAccountProvider subAccountId={subAccountId}>
      <ContactsProvider>
        <BillingGuard>{children}</BillingGuard>
      </ContactsProvider>
    </SubAccountProvider>
  );
}
