// ============================================================================
// OmniFlow — image helpers.
//
// Coach attachments: user pics / screenshots / receipts are re-encoded as
// JPEG data URLs (max long side 1600px) so the encrypted vault blob stays
// small while the image is still legible to a vision LLM.
// ============================================================================

/** Downscale + re-encode an image file to a JPEG data URL. Returns null on
 *  anything that is not a decodable image (the caller shows a toast). */
export function compressImageToDataUrl(file: File, maxLongSide = 1600): Promise<string | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/')) {
      resolve(null);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const long = Math.max(img.width, img.height);
        if (long < 16) {
          resolve(null);
          return;
        }
        const factor = Math.min(1, maxLongSide / long);
        const w = Math.round(img.width * factor);
        const h = Math.round(img.height * factor);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        // White background: transparent PNGs would go black on JPEG encode.
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}
