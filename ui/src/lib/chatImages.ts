// Pasted / displayed chat attachments. Data URLs only — never uploaded as files.
// Images may be inlined as OpenAI/OpenRouter multimodal parts; every kind is
// also dropped into the agent sandbox by the backend and referenced by path.

export const MAX_CHAT_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

export interface ChatImage {
  id: string;
  mime: string;
  dataUrl: string;
  name?: string;
  /** 'image' (renderable/inlineable) or 'file' (sandbox attachment, e.g. pdf). */
  kind?: 'image' | 'file';
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export function isAllowedImageMime(mime: string): boolean {
  return ALLOWED.has((mime || '').toLowerCase());
}

export function isImageAttachment(img: ChatImage): boolean {
  return (img.kind ?? 'image') === 'image' || img.dataUrl.startsWith('data:image/');
}

export function toMultimodalParts(text: string, images: ChatImage[]): ContentPart[] {
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const img of images) {
    if (img.dataUrl && isImageAttachment(img)) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  }
  if (parts.length === 0) parts.push({ type: 'text', text: '' });
  return parts;
}

/** Read a File/Blob into a ChatImage. Images inline; other files ride along as sandbox attachments. */
export function fileToChatImage(file: File | Blob, name?: string): Promise<ChatImage> {
  return new Promise((resolve, reject) => {
    const mime = (file.type || 'application/octet-stream').toLowerCase();
    const isImage = isAllowedImageMime(mime);
    const cap = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (file.size > cap) {
      reject(new Error(`File too large (max ${cap / 1024 / 1024}MB)`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (isImage && !dataUrl.startsWith('data:image/')) {
        reject(new Error('Not an image'));
        return;
      }
      resolve({
        id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        mime,
        dataUrl,
        name: name || (file instanceof File ? file.name : undefined),
        kind: isImage ? 'image' : 'file',
      });
    };
    reader.readAsDataURL(file);
  });
}

/** Pull attachable files out of a paste/drop event — images and documents alike. */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  if (data.files?.length) {
    for (const f of Array.from(data.files)) out.push(f);
  }
  if (out.length === 0 && data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

export async function appendPastedImages(
  current: ChatImage[],
  files: File[],
): Promise<{ next: ChatImage[]; error?: string }> {
  const room = MAX_CHAT_IMAGES - current.length;
  if (room <= 0) return { next: current, error: `At most ${MAX_CHAT_IMAGES} images per message` };
  const take = files.slice(0, room);
  const added: ChatImage[] = [];
  for (const f of take) {
    try {
      added.push(await fileToChatImage(f));
    } catch (err) {
      return { next: current, error: err instanceof Error ? err.message : 'Could not attach image' };
    }
  }
  const extra = files.length > room ? ` (kept first ${room})` : '';
  return {
    next: [...current, ...added],
    error: extra ? `At most ${MAX_CHAT_IMAGES} images per message${extra}` : undefined,
  };
}

/** Best-effort parse of the show_images tool payload. */
export function parseShownImages(raw: string): ChatImage[] {
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.images) ? parsed.images : Array.isArray(parsed) ? parsed : [];
    return list
      .filter((x: any) => x && typeof x.dataUrl === 'string' && x.dataUrl.startsWith('data:image/'))
      .map((x: any, i: number) => ({
        id: String(x.id || `shown_${i}`),
        mime: String(x.mime || 'image/png'),
        dataUrl: x.dataUrl,
        name: typeof x.path === 'string' ? x.path : typeof x.name === 'string' ? x.name : undefined,
      }));
  } catch {
    return [];
  }
}
