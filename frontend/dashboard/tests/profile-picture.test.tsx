// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ replace: vi.fn(), refresh, push: vi.fn() }) }));

import ProfileMenu from "@/components/profile-menu";

const calls: { url: string; init: any }[] = [];
let reply: () => Response;
beforeEach(() => {
  calls.length = 0;
  refresh.mockClear();
  reply = () => new Response(JSON.stringify({ has_avatar: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => { calls.push({ url: String(url), init }); return reply(); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const menu = (props: Partial<React.ComponentProps<typeof ProfileMenu>> = {}) =>
  render(<ProfileMenu name="Olivia Owner" email="o@acme.example" userId="u-1" role="Organization Admin" initials="OO" organization="Alpha" avatarEditable {...props} />);
const card = () => screen.getByRole("group", { name: "Account details", hidden: true });
const file = (type = "image/png", size = 1000) => new File([new Uint8Array(size)], "me.png", { type });
const pick = (f: File) => fireEvent.change(screen.getByTestId("profile-picture-input"), { target: { files: [f] } });

describe("the admin's profile picture", () => {
  it("shows the initials without a picture, and the picture (in the header and the card) with one", () => {
    const { unmount } = menu();
    expect(screen.queryByTestId("profile-picture")).toBeNull();
    expect(screen.getByRole("button", { name: "Account: Olivia Owner" }).textContent).toBe("OO");
    unmount();
    menu({ avatarUrl: "/api/profile/avatar?v=3" });
    const pictures = screen.getAllByTestId("profile-picture") as HTMLImageElement[];
    expect(pictures).toHaveLength(2); // the round header button and the card
    expect(pictures.every((p) => p.getAttribute("src") === "/api/profile/avatar?v=3")).toBe(true);
  });

  it("falls back to the initials when the picture cannot be loaded", () => {
    menu({ avatarUrl: "/api/profile/avatar?v=3" });
    for (const picture of screen.getAllByTestId("profile-picture")) fireEvent.error(picture);
    expect(screen.queryByTestId("profile-picture")).toBeNull();
    expect(screen.getByRole("button", { name: "Account: Olivia Owner" }).textContent).toBe("OO");
  });

  it("offers Add (no picture) or Change and Remove (a picture), and only where the portal allows editing", () => {
    const { unmount } = menu();
    expect(within(card()).getByRole("button", { name: "Add profile picture", hidden: true })).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Remove", hidden: true })).toBeNull();
    unmount();
    const second = menu({ avatarUrl: "/x" });
    expect(within(card()).getByRole("button", { name: "Change profile picture", hidden: true })).toBeTruthy();
    expect(within(card()).getByRole("button", { name: "Remove", hidden: true })).toBeTruthy();
    second.unmount();
    menu({ avatarEditable: false });
    expect(screen.queryByTestId("profile-picture-input")).toBeNull();
  });

  it("uploads the chosen file to the portal's own route (one multipart file) and refreshes the page", async () => {
    menu();
    pick(file("image/jpeg"));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/profile/avatar");
    expect(calls[0].init.method).toBe("PUT");
    expect([...(calls[0].init.body as FormData).keys()]).toEqual(["file"]);
    expect(screen.getByText("Profile picture saved.")).toBeTruthy();
  });

  it("refuses a wrong type or a file over 2 MB without sending anything", async () => {
    menu();
    pick(file("image/gif"));
    expect((await screen.findByRole("alert")).textContent).toBe("Use a PNG, JPEG or WebP picture.");
    pick(file("image/png", 2 * 1024 * 1024 + 1));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The picture must be 2 MB or smaller."));
    expect(calls).toHaveLength(0);
  });

  it("shows the server's reason when it refuses the picture, and does not refresh", async () => {
    reply = () => new Response(JSON.stringify({ error: "This file is not a valid PNG, JPEG or WebP picture." }), { status: 400 });
    menu();
    pick(file());
    expect((await screen.findByRole("alert")).textContent).toContain("not a valid");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("removes the picture", async () => {
    menu({ avatarUrl: "/x" });
    await userEvent.click(within(card()).getByRole("button", { name: "Remove", hidden: true }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(calls[0].init.method).toBe("DELETE");
    expect(screen.getByText("Profile picture removed.")).toBeTruthy();
  });
});

describe("the account card lists its details as left-aligned 'Label : value' lines", () => {
  it("Role, User ID and Organization, labels in the accent colour, no organization logo", () => {
    menu({ organization: "Alpha Trading GmbH" });
    const rows = within(card()).getAllByTestId("profile-detail");
    expect(rows.map((r) => r.textContent)).toEqual(["Role :Organization Admin", "User ID :u-1", "Organization :Alpha Trading GmbH"]);
    for (const row of rows) {
      expect(row.querySelector("dt")!.className).toContain("text-ix-accent-text");
      expect(row.className).not.toMatch(/justify-between|text-right|ml-auto/);
    }
    expect(card().querySelector("img")).toBeNull();
  });
  it("has no Organization line without an organization", () => {
    menu({ organization: null });
    expect(within(card()).getAllByTestId("profile-detail").map((r) => r.querySelector("dt")!.textContent)).toEqual(["Role :", "User ID :"]);
  });
});
