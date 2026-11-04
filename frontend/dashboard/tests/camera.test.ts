import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CAMERA_MESSAGES, CameraSession, CameraState, Decoder, cameraSupport, classifyCameraError } from "@/lib/camera";

const domError = (name: string) => Object.assign(new Error(name), { name });

function fakeStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { tracks, getTracks: () => tracks };
}
function fakeVideo() {
  return { srcObject: null as unknown, play: vi.fn(async () => undefined), pause: vi.fn(), setAttribute: vi.fn() };
}

describe("classifyCameraError and cameraSupport", () => {
  it.each([
    ["NotAllowedError", "permission-denied"], ["PermissionDeniedError", "permission-denied"], ["SecurityError", "permission-denied"],
    ["NotFoundError", "no-camera"], ["DevicesNotFoundError", "no-camera"], ["OverconstrainedError", "no-camera"],
    ["NotReadableError", "in-use"], ["TrackStartError", "in-use"], ["AbortError", "in-use"],
    ["TypeError", "unsupported"], ["SomethingElse", "unknown"],
  ])("%s -> %s", (name, failure) => {
    expect(classifyCameraError(domError(name))).toBe(failure);
  });

  it("copes with odd thrown values", () => {
    for (const odd of [undefined, null, "boom", 42, {}]) expect(classifyCameraError(odd)).toBe("unknown");
  });

  it("explains a page that is not secure before any prompt could be attempted", () => {
    expect(cameraSupport({ isSecureContext: false, mediaDevices: { getUserMedia: () => undefined } })).toEqual({ ok: false, failure: "insecure-context" });
  });

  it("explains a browser without camera support", () => {
    expect(cameraSupport({ isSecureContext: true, mediaDevices: undefined })).toEqual({ ok: false, failure: "unsupported" });
    expect(cameraSupport({ isSecureContext: true, mediaDevices: null })).toEqual({ ok: false, failure: "unsupported" });
    expect(cameraSupport({ isSecureContext: true, mediaDevices: {} })).toEqual({ ok: false, failure: "unsupported" });
  });

  it("is happy with a secure page that has getUserMedia", () => {
    expect(cameraSupport({ isSecureContext: true, mediaDevices: { getUserMedia: () => undefined } })).toEqual({ ok: true });
  });

  it("has a plain-language message for every failure, mentioning the alternatives", () => {
    for (const message of Object.values(CAMERA_MESSAGES)) {
      expect(message.title.length).toBeGreaterThan(10);
      expect(message.help).toMatch(/scanner|type|Try|Reload|Close|Connect|Allow|HTTPS/);
    }
    expect(CAMERA_MESSAGES["insecure-context"].help).toContain("HTTPS");
    expect(CAMERA_MESSAGES["permission-denied"].help).toContain("Allow camera access");
  });
});

describe("CameraSession", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn(() => { throw new Error("the camera code must never touch the network"); });
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function setup(overrides: { getUserMedia?: any; decoder?: Decoder } = {}) {
    const stream = fakeStream();
    const getUserMedia = overrides.getUserMedia ?? vi.fn(async () => stream);
    const decoder: Decoder = overrides.decoder ?? { name: "fake", decode: vi.fn(async () => null), dispose: vi.fn() };
    const onDetect = vi.fn();
    const onFailure = vi.fn();
    const states: CameraState[] = [];
    const session = new CameraSession({
      mediaDevices: { getUserMedia },
      createDecoder: async () => decoder,
      onDetect,
      onFailure,
      onState: (s) => states.push(s),
    });
    return { session, stream, getUserMedia, decoder, onDetect, onFailure, states, video: fakeVideo() };
  }

  it("does nothing, and asks for nothing, until start() is called", () => {
    const { getUserMedia, states } = setup();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it("asks for the rear camera, video only (no microphone)", async () => {
    const { session, getUserMedia, video } = setup();
    await session.start(video);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const constraints = getUserMedia.mock.calls[0][0];
    expect(constraints.audio).toBe(false);
    expect(constraints.video.facingMode).toEqual({ ideal: "environment" });
    expect(video.setAttribute).toHaveBeenCalledWith("playsinline", "true");
    expect(video.srcObject).not.toBeNull();
  });

  it("reports a refused permission clearly, without leaving anything running", async () => {
    const { session, onFailure, states, video } = setup({ getUserMedia: vi.fn(async () => { throw domError("NotAllowedError"); }) });
    await session.start(video);
    expect(onFailure).toHaveBeenCalledWith("permission-denied");
    expect(states).toEqual(["starting", "stopped"]);
    expect(video.srcObject).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([["NotFoundError", "no-camera"], ["NotReadableError", "in-use"], ["TypeError", "unsupported"]])("reports %s as %s", async (name, expected) => {
    const { session, onFailure, video } = setup({ getUserMedia: vi.fn(async () => { throw domError(name); }) });
    await session.start(video);
    expect(onFailure).toHaveBeenCalledWith(expected);
  });

  it("hands over the first code it reads, as plain text", async () => {
    const decode = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("IMX-ABC234DEFGHJ").mockResolvedValue("IMX-ABC234DEFGHJ");
    const { session, onDetect, video } = setup({ decoder: { name: "fake", decode } });
    await session.start(video);
    await vi.advanceTimersByTimeAsync(250);
    expect(onDetect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(onDetect).toHaveBeenCalledWith("IMX-ABC234DEFGHJ");
  });

  it("stop() releases every track, detaches the video, clears the timer and disposes the decoder", async () => {
    const { session, stream, decoder, video, states } = setup();
    await session.start(video);
    expect(vi.getTimerCount()).toBe(1);
    session.stop();
    for (const track of stream.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(video.pause).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(decoder.dispose).toHaveBeenCalled();
    expect(states[states.length - 1]).toBe("stopped");
  });

  it("stop() is safe to call twice, and when the camera was never started", async () => {
    const { session, stream, video } = setup();
    expect(() => session.stop()).not.toThrow();
    await session.start(video);
    session.stop();
    expect(() => session.stop()).not.toThrow();
    for (const track of stream.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("stops decoding after stop(): no more detections", async () => {
    const decode = vi.fn(async () => "BOLT-1");
    const { session, onDetect, video } = setup({ decoder: { name: "fake", decode } });
    await session.start(video);
    session.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(decode).not.toHaveBeenCalled();
    expect(onDetect).not.toHaveBeenCalled();
  });

  it("releases the camera at once if stop() happens while the permission prompt is still open", async () => {
    let grant!: (stream: unknown) => void;
    const stream = fakeStream();
    const { session, video, onFailure } = setup({ getUserMedia: vi.fn(() => new Promise((resolve) => (grant = resolve))) });
    const starting = session.start(video);
    session.stop(); // e.g. the component unmounted
    grant(stream);
    await starting;
    for (const track of stream.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("ignores a second start() while running (one stream, one timer)", async () => {
    const { session, getUserMedia, video } = setup();
    await session.start(video);
    await session.start(video);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("can be started again after it was stopped", async () => {
    const { session, getUserMedia, video } = setup();
    await session.start(video);
    session.stop();
    await session.start(video);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    session.stop();
  });

  it("skips frames the decoder cannot read, and keeps going", async () => {
    const decode = vi.fn().mockRejectedValueOnce(new Error("blurry")).mockResolvedValue("NUT-1");
    const { session, onDetect, video } = setup({ decoder: { name: "fake", decode } });
    await session.start(video);
    await vi.advanceTimersByTimeAsync(500);
    expect(onDetect).toHaveBeenCalledWith("NUT-1");
  });

  it("turns the camera off and reports if the decoder cannot be created", async () => {
    const stream = fakeStream();
    const onFailure = vi.fn();
    const session = new CameraSession({
      mediaDevices: { getUserMedia: async () => stream },
      createDecoder: async () => { throw new Error("module failed to load"); },
      onDetect: vi.fn(),
      onFailure,
    });
    await session.start(fakeVideo());
    for (const track of stream.tracks) expect(track.stop).toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith("unknown");
  });

  it("never sends anything over the network", async () => {
    const decode = vi.fn(async () => "BOLT-1");
    const { session, video } = setup({ decoder: { name: "fake", decode } });
    await session.start(video);
    await vi.advanceTimersByTimeAsync(1000);
    session.stop();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
