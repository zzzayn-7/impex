"use client";

import { useEffect, useRef, useState } from "react";

import { CAMERA_MESSAGES, CameraFailure, CameraSession, CameraState, cameraSupport, createBrowserDecoder } from "@/lib/camera";

type Props = {
  /** Called once with the text of the first code the camera reads; the camera then switches itself off. */
  onDetected: (text: string) => void;
  onClose?: () => void;
};

// The camera is only asked for when the user presses "Start camera". Frames are decoded in this browser tab and are never
// sent anywhere (this component and lib/camera.ts make no network requests). The camera is released when scanning ends,
// when a code is read, and when the component unmounts.
export default function CameraScanner({ onDetected, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<CameraSession | null>(null);
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const [state, setState] = useState<CameraState>("idle");
  const [failure, setFailure] = useState<CameraFailure | null>(null);

  // Turn the camera off if this component goes away for any reason (navigation, the result appearing, closing the panel).
  useEffect(() => () => sessionRef.current?.stop(), []);

  async function start() {
    setFailure(null);
    const support = cameraSupport({ isSecureContext: window.isSecureContext, mediaDevices: navigator.mediaDevices });
    if (!support.ok) {
      setFailure(support.failure); // explained without showing a permission prompt that could never succeed
      return;
    }
    sessionRef.current?.stop();
    const session = new CameraSession({
      mediaDevices: navigator.mediaDevices as any,
      createDecoder: createBrowserDecoder,
      onState: setState,
      onFailure: setFailure,
      onDetect: (text) => {
        session.stop(); // one code per camera session: stop first so the same frame cannot report twice
        onDetectedRef.current(text);
      },
    });
    sessionRef.current = session;
    if (videoRef.current) await session.start(videoRef.current);
  }

  function stop() {
    sessionRef.current?.stop();
    onClose?.();
  }

  const running = state === "starting" || state === "scanning";
  const message = failure ? CAMERA_MESSAGES[failure] : null;

  return (
    <section aria-label="Camera scanner" className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className={`relative overflow-hidden rounded-lg bg-black ${running ? "" : "hidden"}`}>
        {/* muted + playsInline: required for the video to start inline on iPhones */}
        <video ref={videoRef} muted playsInline className="aspect-[4/3] w-full object-cover sm:aspect-video" aria-label="Camera preview" />
        <div aria-hidden className="pointer-events-none absolute inset-6 rounded-lg border-2 border-indigo-400/70 sm:inset-10" />
        {state === "starting" && <p role="status" className="absolute inset-x-0 bottom-2 text-center text-xs text-slate-200">Starting camera…</p>}
      </div>

      {message && (
        <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <p className="font-semibold">{message.title}</p>
          <p className="mt-1 text-xs text-amber-300/90">{message.help}</p>
        </div>
      )}

      {state === "scanning" && <p role="status" className="text-xs text-slate-400">Point the camera at a QR code or barcode. Nothing is recorded or uploaded; the picture stays on this device.</p>}
      {!running && !message && <p className="text-xs text-slate-400">Your browser will ask for permission when you press Start camera. The picture stays on this device and is never uploaded.</p>}

      <div className="flex flex-wrap gap-2">
        {running ? (
          <button type="button" onClick={stop} className="min-h-11 flex-1 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 sm:flex-none">
            Stop camera
          </button>
        ) : (
          <>
            <button type="button" onClick={start} className="min-h-11 flex-1 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 sm:flex-none">
              {failure || state === "stopped" ? "Try the camera again" : "Start camera"}
            </button>
            {onClose && (
              <button type="button" onClick={onClose} className="min-h-11 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">
                Close
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
