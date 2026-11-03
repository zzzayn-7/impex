import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getTenantAdmin } from "@/lib/tenant-session";
import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "Sign in | Impex Organization Portal",
};

export default async function LoginPage() {
  // Already signed in as an organization administrator? Go straight to the dashboard.
  if (await getTenantAdmin()) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="h-11 w-11 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white text-xl shadow-md shadow-indigo-600/30">
            IX
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">IMPEX Organization Portal</h1>
            <p className="mt-1 text-sm text-slate-400">Sign in to your organization</p>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6 shadow-sm">
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
