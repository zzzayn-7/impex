import type { Metadata } from "next";

import { requireTenantAdmin } from "@/lib/tenant-session";
import ChangePasswordForm from "./change-password-form";

export const metadata: Metadata = {
  title: "Choose a new password | Impex Organization Portal",
};

// Where an administrator lands after the Super Admin reset their password: the temporary password they were emailed is the "current" password here, and they choose their own. Nothing else in
// the portal opens until they have (every page checks it). Any signed-in administrator may also open it on purpose to change theirs.
export default async function ChangePasswordPage() {
  const admin = await requireTenantAdmin();
  return (
    <div className="ix-dash">
      <main className="ix-page flex min-h-screen items-center justify-center px-4 py-12">
        <div className="w-full max-w-md space-y-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-ix-butter text-xl font-bold text-ix-on-accent shadow-lg shadow-black/20">IX</div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-ix-text">Choose a new password</h1>
              <p className="mt-1 text-sm text-ix-muted">
                {admin.must_change_password ? "Your password was reset. Enter the temporary password from the email, then choose your own." : "Enter your current password, then choose a new one."}
              </p>
            </div>
          </div>
          <div className="ix-panel relative p-6">
            <ChangePasswordForm email={admin.email} forced={admin.must_change_password === true} />
          </div>
        </div>
      </main>
    </div>
  );
}
