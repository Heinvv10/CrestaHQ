import {
  LOGO_MAX_BYTES,
  LOGO_MAX_EDGE,
  LOGO_SOURCE_MAX_BYTES,
  type LogoMime,
} from "@/lib/brand/logo-shared";

/**
 * Resizes a logo in the browser so the server needs no image library. Keeps
 * the aspect ratio and transparency; PNG first, WebP when PNG is too heavy.
 */

const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that image. Try a PNG or JPG."));
    };
    img.src = url;
  });
}

function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export async function renderLogo(
  file: File,
): Promise<{ base64: string; mime: LogoMime }> {
  if (!ACCEPTED.includes(file.type)) {
    throw new Error("Use a PNG, JPG, WebP or SVG file.");
  }
  if (file.size > LOGO_SOURCE_MAX_BYTES) {
    throw new Error("That file is over 5 MB. Use a smaller image.");
  }

  const img = await loadImage(file);
  // SVGs without width/height report 0; give them a sensible canvas.
  const w = img.naturalWidth || LOGO_MAX_EDGE;
  const h = img.naturalHeight || LOGO_MAX_EDGE;
  const scale = Math.min(1, LOGO_MAX_EDGE / Math.max(w, h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas isn't available in this browser.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, outW, outH);

  for (const mime of ["image/png", "image/webp"] as const) {
    const dataUrl = canvas.toDataURL(mime, 0.9);
    // Browsers without WebP encoding silently return PNG instead.
    if (!dataUrl.startsWith(`data:${mime}`)) continue;
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (base64Bytes(base64) <= LOGO_MAX_BYTES) return { base64, mime };
  }
  throw new Error("That logo is too detailed to store. Try a simpler image.");
}
