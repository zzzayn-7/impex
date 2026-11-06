import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import PortalHeader from "@/components/portal-header";
import { getSessionToken, requireSuperAdmin } from "@/lib/auth";
import { UUID_RE, getHistory, getModules } from "@/lib/modules";
import { getUnreadCount } from "@/lib/support";
import ModuleManager from "./module-manager";

export const metadata: Metadata = {
  title: "Module management | Impex Super Admin",
};
export const dynamic = "force-dynamic";

// Module management for ONE organization: which business modules it can use. Only a Super Admin gets here (and the Organization Service
// checks the role again on every call the page and its buttons make).
export default async function OrganizationModulesPage({ params }: { params: { id: string } }) {
  const user = await requireSuperAdmin();
  const token = getSessionToken() ?? "";
  const unread = (await getUnreadCount(token)) ?? 0;
  const back = <Link href="/organizations" className="text-xs text-indigo-300 hover:text-indigo-200">← Organizations</Link>;
  const frame = (content: React.ReactNode) => (
    <div className="flex min-h-screen flex-col">
      <PortalHeader user={user} current="organizations" supportUnread={unread} />
      <main className="mx-auto w-full max-w-5xl flex-1 space-y-6 p-8">{back}{content}</main>
    </div>
  );
  const notice = (text: string) => <p role="alert" className="rounded-lg border border-dashed border-slate-800 px-4 py-10 text-center text-sm text-slate-400">{text}</p>;

  if (!UUID_RE.test(params.id)) return frame(notice("Organization not found."));
  const [state, history] = await Promise.all([getModules(token, params.id), getHistory(token, params.id)]);
  if ((!state.ok && state.reason === "unauthorized") || (!history.ok && history.reason === "unauthorized")) redirect("/login");
  if (!state.ok) {
    return frame(notice(state.reason === "not-found" ? "Organization not found." : state.reason === "forbidden" ? "Only a Super Admin can manage modules." : "The organization service is unavailable. Nothing was changed; refresh in a moment."));
  }
  return frame(<ModuleManager initial={state.data} initialHistory={history.ok ? history.data : { items: [], total: 0 }} historyUnavailable={!history.ok} />);
}
