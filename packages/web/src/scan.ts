// Reads a QR code with the camera. jsQR does the decoding; this owns the camera and the loop.

import jsQR from "jsqr";

/** Frames are decoded this often; a QR code holds still, so more would only burn battery. */
const DECODE_EVERY_MS = 150;

/** The camera needs a secure page and a browser that offers it. */
export const canScan = (): boolean =>
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getUserMedia === "function" &&
  typeof window !== "undefined" &&
  window.isSecureContext;

export interface Scanner {
  stop(): void;
}

/**
 * Shows the back camera in `video` and calls `onCode` once with the first QR code it reads,
 * then stops. Rejects when the camera cannot be opened; see `cameraProblem` for the words.
 */
export async function scanQr(
  video: HTMLVideoElement,
  onCode: (text: string) => void,
): Promise<Scanner> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
  const tick = () => {
    if (stopped) return;
    const text =
      context && video.readyState >= video.HAVE_ENOUGH_DATA
        ? decode(video, canvas, context)
        : undefined;
    if (text) {
      stop();
      onCode(text);
      return;
    }
    timer = setTimeout(tick, DECODE_EVERY_MS);
  };
  tick();
  return { stop };
}

function decode(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): string | undefined {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  if (!canvas.width || !canvas.height) return undefined;
  context.drawImage(video, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
  return code?.data.trim() || undefined;
}

/** What to tell the person when `scanQr` rejects. */
export function cameraProblem(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "The browser was not allowed to use the camera.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera was found.";
    case "NotReadableError":
      return "The camera is in use by another app.";
    default:
      return "The camera could not be opened.";
  }
}
