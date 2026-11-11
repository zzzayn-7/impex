// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

import DashboardFrame from "@/components/dashboard/frame";

afterEach(cleanup);

const admin = { id: "u", email: "o@x.y", full_name: "Olivia Owner", role: "organization-admin", organization_id: "o", is_active: true, created_at: "x" } as any;
const mount = (organization: any) => render(<DashboardFrame admin={admin} organization={organization}><p>page</p></DashboardFrame>);

describe("the top of the sidebar is the organization", () => {
  it("shows the organization's name and logo where 'Impex' used to be", () => {
    mount({ name: "Alpha Trading GmbH", has_logo: true, logo_version: "v3", modules: ["inventory"] });
    expect(screen.getByTestId("sidebar-org-name").textContent).toBe("Alpha Trading GmbH");
    expect(screen.getByTestId("sidebar-logo").getAttribute("src")).toBe("/api/organization/logo?v=v3");
    expect(document.getElementById("ix-sidebar")!.textContent).not.toContain("IX");
  });
  it("falls back to the monogram when there is no logo, and to Impex when there is no organization yet", () => {
    const { unmount } = mount({ name: "Alpha Trading GmbH", has_logo: false, modules: ["inventory"] });
    expect(screen.getByTestId("sidebar-monogram").textContent).toBe("AT");
    unmount();
    mount(null);
    expect(screen.getByTestId("sidebar-org-name").textContent).toBe("Impex");
  });
});
