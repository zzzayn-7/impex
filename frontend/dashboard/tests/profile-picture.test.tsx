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

const edit = () => within(card()).getByRole("button", { name: "Edit profile picture", hidden: true });
const choose = (name: string) => within(card()).getByRole("menuitem", { name, hidden: true });

describe("the admin's profile picture", () => {
  it("shows the initials without a picture, and the picture (in the header and, centred in its frame, in the card) with one", () => {
    const { unmount } = menu();
    expect(screen.queryByTestId("profile-picture")).toBeNull();
    expect(screen.getByRole("button", { name: "Account: Olivia Owner" }).textContent).toBe("OO");
    unmount();
    menu({ avatarUrl: "/api/profile/avatar?v=3" });
    const pictures = screen.getAllByTestId("profile-picture") as HTMLImageElement[];
    expect(pictures).toHaveLength(2); // the round header button and the card
    expect(pictures.every((p) => p.getAttribute("src") === "/api/profile/avatar?v=3")).toBe(true);
    expect(card().querySelector("[data-picture-editor]")!.className).toContain("mx-auto"); // centred
  });

  it("falls back to the initials when the picture cannot be loaded", () => {
    menu({ avatarUrl: "/api/profile/avatar?v=3" });
    for (const picture of screen.getAllByTestId("profile-picture")) fireEvent.error(picture);
    expect(screen.queryByTestId("profile-picture")).toBeNull();
    expect(screen.getByRole("button", { name: "Account: Olivia Owner" }).textContent).toBe("OO");
  });

  it("has no 'Add profile picture' button: an edit icon beside the picture asks whether to take one or choose one from the files", async () => {
    menu();
    expect(within(card()).queryByRole("button", { name: /Add profile picture|Change profile picture/, hidden: true })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Account: Olivia Owner" }));
    expect(edit().getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(edit());
    expect(edit().getAttribute("aria-expanded")).toBe("true");
    expect(within(card()).getByRole("menu", { name: "Profile picture", hidden: true })).toBeTruthy();
    expect(within(card()).getAllByRole("menuitem", { hidden: true }).map((i) => i.textContent)).toEqual(["Take a picture", "Choose from files"]); // no Remove: there is no picture yet
  });

  it("offers Remove only when there is a picture, and only where the portal allows editing", async () => {
    const { unmount } = menu({ avatarUrl: "/x" });
    await userEvent.click(edit());
    expect(within(card()).getAllByRole("menuitem", { hidden: true }).map((i) => i.textContent)).toEqual(["Take a picture", "Choose from files", "Remove picture"]);
    unmount();
    menu({ avatarEditable: false });
    expect(screen.queryByTestId("profile-picture-input")).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Edit profile picture", hidden: true })).toBeNull();
  });

  it("'Choose from files' opens the file chooser, and the chosen file goes to the portal's own route (one multipart file) and the page refreshes", async () => {
    menu();
    const click = vi.spyOn(screen.getByTestId("profile-picture-input"), "click");
    await userEvent.click(edit());
    await userEvent.click(choose("Choose from files"));
    expect(click).toHaveBeenCalledTimes(1);
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
    await userEvent.click(edit());
    await userEvent.click(choose("Remove picture"));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(calls[0].init.method).toBe("DELETE");
    expect(screen.getByText("Profile picture removed.")).toBeTruthy();
  });

  it("the chooser closes with Escape or a click elsewhere", async () => {
    menu();
    await userEvent.click(edit());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
    await userEvent.click(edit());
    await userEvent.click(document.body);
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
  });
});

describe("taking a picture with the camera", () => {
  const stop = vi.fn();
  function camera(width = 640, height = 480) {
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } });
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => width });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => height });
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as any;
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) { cb(new Blob([new Uint8Array(500)], { type: "image/jpeg" })); } as any;
    (URL as any).createObjectURL = vi.fn(() => "blob:shot");
    (URL as any).revokeObjectURL = vi.fn();
  }
  afterEach(() => { stop.mockClear(); Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined }); });

  async function openCamera() {
    await userEvent.click(edit());
    await userEvent.click(choose("Take a picture"));
    return screen.findByRole("dialog");
  }

  it("opens the camera, takes a photo, shows it, and uploads it when it is used; the camera is switched off", async () => {
    camera();
    menu();
    const dialog = await openCamera();
    expect(card().contains(dialog)).toBe(false); // in the page itself: the card has a transform of its own, which would make "fixed" mean "fixed to the card"
    expect((navigator.mediaDevices.getUserMedia as any)).toHaveBeenCalledWith({ video: { facingMode: "user" }, audio: false });
    await userEvent.click(within(dialog).getByRole("button", { name: "Take photo" }));
    expect(within(dialog).getByAltText("Your new profile picture")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Use this photo" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(calls[0].init.method).toBe("PUT");
    const sent = (calls[0].init.body as FormData).get("file") as File;
    expect(sent.type).toBe("image/jpeg");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stop).toHaveBeenCalled(); // the camera light goes off
  });

  it("can retake the photo, and cancelling uploads nothing and switches the camera off", async () => {
    camera();
    menu();
    const dialog = await openCamera();
    await userEvent.click(within(dialog).getByRole("button", { name: "Take photo" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Retake" }));
    expect(within(dialog).getByRole("button", { name: "Take photo" })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toHaveLength(0);
    expect(stop).toHaveBeenCalled();
  });

  it("says so, and points to the files, when the camera is not available or access is refused", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    const { unmount } = menu();
    expect((await (await openCamera()).textContent)).toContain("choose a picture from your files");
    unmount();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => { throw new Error("denied"); }) } });
    menu();
    expect((await within(await openCamera()).findByRole("alert")).textContent).toContain("Allow camera access");
  });

  it("Escape closes only the camera", async () => {
    camera();
    menu();
    await openCamera();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
