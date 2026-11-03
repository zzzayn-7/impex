import type { Metadata } from "next";

import ActivateForm from "./activate-form";

export const metadata: Metadata = {
  title: "Activate your account | Impex",
  robots: { index: false, follow: false },
};

// PUBLIC page: deliberately no Super Admin session check. The invitation token arrives in the URL
// fragment (#token=...), which browsers never send to servers, so it is read client-side only.
export default function ActivatePage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="h-11 w-11 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white text-xl shadow-md shadow-indigo-600/30">
            IX
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">Activate your account</h1>
            <p className="mt-1 text-sm text-slate-400">Set up your organization administrator access</p>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6 shadow-sm">
          <ActivateForm />
        </div>
      </div>
    </main>
  );
}
