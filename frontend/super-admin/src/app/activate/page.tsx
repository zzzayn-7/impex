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
    <div className="ix-dash">
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-ix-butter text-xl font-bold text-ix-deep shadow-lg shadow-black/20">IX</div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-ix-text">Activate your account</h1>
            <p className="mt-1 text-sm text-ix-muted">Set up your organization administrator access</p>
          </div>
        </div>

        <div className="ix-panel relative p-6">
          <ActivateForm />
        </div>
      </div>
    </main>
    </div>
  );
}
