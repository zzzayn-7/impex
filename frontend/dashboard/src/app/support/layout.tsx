import PortalFrame from "@/components/portal-frame";

// Help & Support uses the same frame as every other page, with ONE difference on purpose: it does not send an administrator whose first-time setup
// is unfinished to /setup, so a newly invited administrator with an onboarding problem can ask for help WITHOUT finishing setup first (the frame
// then shows a "Back to setup" note). Authentication is unchanged (a signed-in, active organization administrator is required, checked before the
// page streams) and the Support Service re-checks the caller and their organization on every request.
export default async function SupportLayout({ children }: { children: React.ReactNode }) {
  return PortalFrame({ current: "support", allowIncompleteSetup: true, pageHandlesOutage: true, width: "narrow", children });
}
