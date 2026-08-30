import {
  ICON_BACKGROUND,
  ICON_VARIANTS,
  type IconVariantKey,
} from "@/lib/pwa/icon-variants";

/**
 * Client-side icon rendering — the browser does the resizing so the server
 * never needs a native image library (no sharp, no serverless binary).
 * The uploaded file (PNG/JPG/WebP/SVG) is contain-fitted onto a filled
 * square canvas per variant and exported as PNG base64 (no data: prefix).
 */

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
      reject(new Error("Couldn't read that image — try a PNG or JPG."));
    };
    img.src = url;
  });
}

export async function renderIconVariants(
  file: File,
): Promise<Record<IconVariantKey, string>> {
  const img = await loadImage(file);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) {
    throw new Error("Couldn't read that image — try a PNG or JPG.");
  }
  if (Math.max(w, h) < 192) {
    throw new Error("Image is too small — use at least 512×512 for a crisp icon.");
  }

  const out = {} as Record<IconVariantKey, string>;
  for (const variant of ICON_VARIANTS) {
    const canvas = document.createElement("canvas");
    canvas.width = variant.size;
    canvas.height = variant.size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas isn't available in this browser.");

    ctx.fillStyle = ICON_BACKGROUND;
    ctx.fillRect(0, 0, variant.size, variant.size);

    const inner = variant.size * (1 - 2 * variant.pad);
    const scale = Math.min(inner / w, inner / h);
    const drawW = w * scale;
    const drawH = h * scale;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      img,
      (variant.size - drawW) / 2,
      (variant.size - drawH) / 2,
      drawW,
      drawH,
    );

    const dataUrl = canvas.toDataURL("image/png");
    out[variant.key] = dataUrl.slice(dataUrl.indexOf(",") + 1);
  }
  return out;
}
