import React from 'react';
import { FileText, X } from 'lucide-react';
import { isImageAttachment, type ChatImage } from '../../lib/chatImages';

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
          {isImageAttachment(img) ? (
            <img src={img.dataUrl} alt={img.name || 'paste'} className="h-16 w-16 object-cover block" />
          ) : (
            <div className="h-16 w-16 flex flex-col items-center justify-center gap-1 px-1" title={img.name || 'file'}>
              <FileText className="w-5 h-5 text-txt-secondary" />
              <span className="text-[9px] font-mono text-txt-secondary truncate max-w-full">{img.name || 'file'}</span>
            </div>
          )}
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
