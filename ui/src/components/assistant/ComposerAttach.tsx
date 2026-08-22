import React from 'react';
import { X } from 'lucide-react';
import type { ChatImage } from '../../lib/chatImages';

/** Pending-paste strip shown above the composer textarea. */
export const ComposerAttach: React.FC<{
  images: ChatImage[];
  onRemove: (id: string) => void;
}> = ({ images, onRemove }) => {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {images.map(img => (
        <div
          key={img.id}
          className="relative group rounded-lg overflow-hidden border border-border-subtle bg-surface-base"
        >
          <img src={img.dataUrl} alt={img.name || 'paste'} className="h-16 w-16 object-cover block" />
          <button
            type="button"
            onClick={() => onRemove(img.id)}
            title="Remove"
            className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-surface-canvas/90 text-txt-secondary hover:text-txt-primary flex items-center justify-center"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  );
};
