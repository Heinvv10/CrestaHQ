"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { CompanyForm } from "@/components/companies/company-form";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { createCompany } from "@/lib/firestore/companies";
import type { CompanyFormData } from "@/types/companies";

export function AddCompanySheet() {
  const { subAccountId, agencyId } = useSubAccount();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  // The client-SDK write needs the Firebase user, which resolves a beat after
  // the page paints. Keep the trigger disabled until then rather than
  // swallowing the click.
  const ready = !!user && !!agencyId;

  async function handleCreate(data: CompanyFormData) {
    if (!user || !agencyId) throw new Error("auth not ready");
    await createCompany({ agencyId, subAccountId }, user.uid, data);
    toast.success("Company added");
    setOpen(false);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={!ready}>
        <Plus className="mr-1 h-4 w-4" />
        Add Company
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Add Company</SheetTitle>
            <SheetDescription>
              An organisation your contacts belong to.
            </SheetDescription>
          </SheetHeader>
          <div className="p-4 pt-0">
            <CompanyForm
              onSubmit={handleCreate}
              onCancel={() => setOpen(false)}
              submitLabel="Add Company"
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
