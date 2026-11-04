// Camera scanning, kept free of React so it can be tested with fakes.
//
// Privacy and safety rules implemented here:
//   * the camera is requested ONLY when start() is called (the user pressed "Start camera"), never on page load;
//   * frames are decoded in the browser; this module has no network access at all, so no video or image can leave the device;
//   * stop() (and the component's unmount) always releases every track, so the camera light goes off;
//   * a scanned value is handed over as plain text; nothing here opens or follows it.

export type CameraFailure = "permission-denied" | "insecure-context" | "unsupported" | "no-camera" | "in-use" | "unknown";

export const CAMERA_MESSAGES: Record<CameraFailure, { title: string; help: string }> = {
  "permission-denied": {
    title: "Camera access was blocked",
    help: "Allow camera access for this site in your browser's address-bar or site settings, then press Start camera again. You can keep scanning with a USB/Bluetooth scanner or by typing the code.",
  },
  "insecure-context": {
    title: "The camera needs a secure (HTTPS) connection",
    help: "Browsers only allow camera access on https:// pages (or localhost). Open the portal over HTTPS, see docs/scanning.md, or use a hardware scanner or type the code instead.",
  },
  unsupported: {
    title: "This browser cannot use the camera for scanning",
    help: "Try a current Chrome, Edge, Safari or Firefox. You can still use a USB/Bluetooth scanner or type the code.",
  },
  "no-camera": {
    title: "No camera was found",
    help: "Connect a camera or open this page on a phone or tablet. You can still use a USB/Bluetooth scanner or type the code.",
  },
  "in-use": {
    title: "The camera is busy",
    help: "Another app or browser tab is using the camera. Close it and press Start camera again.",
  },
  unknown: {
    title: "The camera could not be started",
    help: "Reload the page and try again, or use a USB/Bluetooth scanner or type the code.",
  },
};

export function classifyCameraError(error: unknown): CameraFailure {
  const name = typeof error === "object" && error !== null ? String((error as { name?: unknown }).name ?? "") : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "permission-denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "no-camera";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "in-use";
    case "TypeError":
      return "unsupported";
    default:
      return "unknown";
  }
}

export type CameraEnvironment = {
  isSecureContext?: boolean;
  mediaDevices?: { getUserMedia?: unknown } | null;
};

/** Can this page ask for the camera at all? (Checked before prompting, so the message is exact.) */
export function cameraSupport(env: CameraEnvironment): { ok: true } | { ok: false; failure: CameraFailure } {
  if (env.isSecureContext === false) return { ok: false, failure: "insecure-context" };
  if (!env.mediaDevices || typeof env.mediaDevices.getUserMedia !== "function") return { ok: false, failure: "unsupported" };
  return { ok: true };
}

// ---- the decoder: the browser's built-in detector when there is one, otherwise ZXing (pure JavaScript) ---------------------
export type Decoder = {
  name: "BarcodeDetector" | "ZXing" | string;
  decode(video: HTMLVideoElement): Promise<string | null>;
  dispose?(): void;
};

const FORMATS = ["qr_code", "code_128", "code_39", "code_93", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "codabar", "data_matrix"];

export async function createBrowserDecoder(): Promise<Decoder> {
  const NativeDetector = (globalThis as any).BarcodeDetector;
  if (NativeDetector) {
    try {
      const supported: string[] = typeof NativeDetector.getSupportedFormats === "function" ? await NativeDetector.getSupportedFormats() : FORMATS;
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.length > 0) {
        const detector = new NativeDetector({ formats });
        return {
          name: "BarcodeDetector",
          async decode(video) {
            const found = await detector.detect(video);
            return found?.[0]?.rawValue ?? null;
          },
        };
      }
    } catch {
      // fall through to ZXing
    }
  }
  const { BrowserMultiFormatReader } = await import("@zxing/browser");
  const { BarcodeFormat, DecodeHintType } = await import("@zxing/library");
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.ITF, BarcodeFormat.CODABAR,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new BrowserMultiFormatReader(hints);
  const canvas = document.createElement("canvas");
  return {
    name: "ZXing",
    async decode(video) {
      if (!video.videoWidth || !video.videoHeight) return null;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d", { willReadFrequently: true })?.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        return reader.decodeFromCanvas(canvas).getText();
      } catch {
        return null; // nothing readable in this frame
      }
    },
  };
}

// ---- the session: start, look for codes, stop -----------------------------------------------------------------------------
export type VideoLike = {
  srcObject: unknown;
  play?: () => Promise<void> | void;
  pause?: () => void;
  setAttribute?: (name: string, value: string) => void;
};
type TrackLike = { stop(): void };
type StreamLike = { getTracks(): TrackLike[] };
export type CameraState = "idle" | "starting" | "scanning" | "stopped";

export type CameraDeps = {
  mediaDevices: { getUserMedia(constraints: unknown): Promise<unknown> };
  createDecoder: () => Promise<Decoder>;
  onDetect: (text: string) => void;
  onFailure: (failure: CameraFailure) => void;
  onState?: (state: CameraState) => void;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

export class CameraSession {
  private stream: StreamLike | null = null;
  private video: VideoLike | null = null;
  private decoder: Decoder | null = null;
  private timer: unknown = null;
  private decoding = false;
  private generation = 0; // bumped by stop(): a start() that finishes later notices it was cancelled
  state: CameraState = "idle";

  constructor(private readonly deps: CameraDeps) {}

  private setState(state: CameraState) {
    this.state = state;
    this.deps.onState?.(state);
  }

  async start(video: VideoLike): Promise<void> {
    if (this.state === "starting" || this.state === "scanning") return;
    const generation = ++this.generation;
    this.setState("starting");
    let stream: StreamLike;
    try {
      // Rear camera preferred on phones; no audio is ever requested.
      stream = (await this.deps.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })) as StreamLike;
    } catch (error) {
      if (generation === this.generation) {
        this.setState("stopped");
        this.deps.onFailure(classifyCameraError(error));
      }
      return;
    }
    if (generation !== this.generation) {
      // stop() (or an unmount) happened while the permission prompt was open: release the camera at once
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;
    this.video = video;
    video.setAttribute?.("playsinline", "true"); // iOS Safari: do not take over the screen
    video.srcObject = stream;
    try {
      await video.play?.();
      this.decoder = await this.deps.createDecoder();
    } catch (error) {
      this.release();
      this.setState("stopped");
      this.deps.onFailure(classifyCameraError(error));
      return;
    }
    if (generation !== this.generation) {
      this.release();
      return;
    }
    this.setState("scanning");
    const every = this.deps.setInterval ?? ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms));
    this.timer = every(() => void this.tick(), this.deps.intervalMs ?? 250);
  }

  private async tick() {
    if (this.decoding || !this.decoder || !this.video || this.state !== "scanning") return;
    this.decoding = true;
    try {
      const text = await this.decoder.decode(this.video as unknown as HTMLVideoElement);
      if (text && this.state === "scanning") this.deps.onDetect(text);
    } catch {
      // a frame that cannot be decoded is simply skipped
    } finally {
      this.decoding = false;
    }
  }

  private release() {
    const clear = this.deps.clearInterval ?? ((handle: unknown) => globalThis.clearInterval(handle as number));
    if (this.timer !== null) clear(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) {
      this.video.pause?.();
      this.video.srcObject = null;
      this.video = null;
    }
    this.decoder?.dispose?.();
    this.decoder = null;
  }

  /** Turn the camera off. Safe to call at any time, any number of times (also while a permission prompt is open). */
  stop() {
    this.generation++;
    this.release();
    if (this.state !== "idle") this.setState("stopped");
  }
}
