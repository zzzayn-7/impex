import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getSuperAdmin } from "@/lib/auth";
import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "Sign in | Impex Super Admin",
};

export default async function LoginPage() {
  // Already signed in as a Super Admin? Go straight to the dashboard.
  if (await getSuperAdmin()) redirect("/");

  return (
    <div className="ix-dash">
    <main className="ix-page flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-ix-butter text-xl font-bold text-ix-on-accent shadow-lg shadow-black/20">IX</div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-ix-text">IMPEX Super Admin</h1>
            <p className="mt-1 text-sm text-ix-muted">Sign in to continue</p>
          </div>
        </div>

        <div className="ix-panel relative p-6">
          <LoginForm />
        </div>
      </div>
    </main>
    </div>
  );
}
