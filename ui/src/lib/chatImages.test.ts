import { describe, it, expect } from 'vitest';
import { fileToChatImage, imageFilesFromClipboard, parseShownImages, toMultimodalParts, isAllowedImageMime } from './chatImages';

function fileFrom(parts: BlobPart[], type: string, name: string): File {
  return new File(parts, name, { type });
}

describe('chatImages', () => {
  it('accepts common image mimes', () => {
    expect(isAllowedImageMime('image/png')).toBe(true);
    expect(isAllowedImageMime('image/jpeg')).toBe(true);
    expect(isAllowedImageMime('image/webp')).toBe(true);
    expect(isAllowedImageMime('application/pdf')).toBe(false);
  });

  it('builds OpenRouter-style multimodal parts', () => {
    const parts = toMultimodalParts('look', [
      { id: '1', mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' },
    ]);
    expect(parts[0]).toEqual({ type: 'text', text: 'look' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
  });

  it('never inlines non-image attachments into provider parts', () => {
    const parts = toMultimodalParts('read this', [
      { id: '2', mime: 'application/pdf', dataUrl: 'data:application/pdf;base64,BBBB', name: 'paper.pdf', kind: 'file' },
    ]);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'text', text: 'read this' });
  });

  it('accepts a pdf file as a file-kind attachment', async () => {
    const f = fileFrom([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'application/pdf', 'research-paper1.pdf');
    const att = await fileToChatImage(f);
    expect(att.kind).toBe('file');
    expect(att.name).toBe('research-paper1.pdf');
    expect(att.dataUrl.startsWith('data:application/pdf;base64,')).toBe(true);
  });

  it('marks pasted screenshots as image-kind', async () => {
    const f = fileFrom([new Uint8Array([0x89, 0x50])], 'image/png', 'shot.png');
    const att = await fileToChatImage(f);
    expect(att.kind).toBe('image');
  });

  it('collects non-image files from clipboard too', () => {
    const dt = {
      files: [
        fileFrom([new Uint8Array([1])], 'application/pdf', 'a.pdf'),
        fileFrom([new Uint8Array([2])], 'text/plain', 'notes.txt'),
      ],
      items: null,
    } as unknown as DataTransfer;
    expect(imageFilesFromClipboard(dt).map(f => f.name)).toEqual(['a.pdf', 'notes.txt']);
  });

  it('parses show_images tool output', () => {
    const raw = JSON.stringify({
      images: [{ path: 'docs/a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' }],
    });
    const imgs = parseShownImages(raw);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].name).toBe('docs/a.png');
    expect(parseShownImages('not json')).toEqual([]);
  });
});
