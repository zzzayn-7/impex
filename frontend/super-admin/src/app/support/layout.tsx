import { requireSuperAdmin } from "@/lib/auth";

// The Support Inbox is for Super Admins only. The check lives here, above the loading boundary, so that anyone else gets a real HTTP
// redirect to the login page before any part of the page is streamed (the pages check again and need the user for the header).
export default async function SupportLayout({ children }: { children: React.ReactNode }) {
  await requireSuperAdmin();
  return <>{children}</>;
}
