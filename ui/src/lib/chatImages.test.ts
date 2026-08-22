import { describe, it, expect } from 'vitest';
import { parseShownImages, toMultimodalParts, isAllowedImageMime } from './chatImages';

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
