import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  Pencil,
  RotateCcw,
  X,
  XCircle,
} from 'lucide-react';
import type { ChatMessage, ToolCall } from '../../lib/assistantEngine';
import { messageParts } from '../../lib/assistantEngine';
import { Markdown } from '../Markdown';
import { CommandApproval } from './CommandApproval';
import { isImageAttachment, parseShownImages, type ChatImage } from '../../lib/chatImages';

/**
 * Shared renderer for a single chat turn — used by the repo ChatSurface and
 * the dashboard HomeChat so both stay visually identical.
 *
 * Assistant turns render ordered parts (reasoning → tool cards → answer text),
 * matching LibreChat-style chronological content arrays.
 */

interface ChatMessageViewProps {
  message: ChatMessage;
  /** True while this message is still receiving streamed events. */
  streaming?: boolean;
  /** When set on a user message, offers inline edit-and-resend. */
  onEdit?: (messageId: string, newText: string) => void;
  /** When set on a user message, offers restarting the turn from here. */
  onRestart?: (messageId: string) => void;
  /** When set on an assistant message, offers regenerating this response. */
  onRegenerate?: (messageId: string) => void;
}

export const ChatMessageView: React.FC<ChatMessageViewProps> = ({
  message,
  streaming = false,
  onEdit,
  onRestart,
  onRegenerate,
}) => {
  const isUser = message.role === 'user';
  const parts = isUser ? [] : messageParts(message);
  const hasText = parts.some(p => p.type === 'text');
  const hasReasoning = parts.some(p => p.type === 'reasoning');
  const hasTools = parts.some(p => p.type === 'tool');
  const waiting = streaming && !hasText && !hasReasoning && !hasTools;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  return (
    <div className={`group ${isUser ? 'flex flex-col items-end' : ''}`}>
      <div className={`min-w-0 w-full ${isUser ? 'flex flex-col items-end max-w-[85%] ml-auto' : ''}`}>
        {isUser ? (
          editing ? (
            <div className="w-full flex flex-col gap-1.5">
              <textarea
                autoFocus
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (!draft.trim()) return;
                    setEditing(false);
                    onEdit?.(message.id, draft);
                  } else if (e.key === 'Escape') {
                    setEditing(false);
                    setDraft(message.content);
                  }
                }}
                rows={Math.min(6, draft.split('\n').length + 1)}
                className="resize-none w-full rounded-lg px-3 py-2 bg-surface-base border border-brand text-txt-primary text-xs font-mono outline-none"
              />
              <div className="flex justify-end gap-2 text-[11px]">
                <button onClick={() => { setEditing(false); setDraft(message.content); }} className="px-2 py-1 rounded text-txt-secondary hover:text-txt-primary transition">
                  Cancel
                </button>
                <button
                  onClick={() => { setEditing(false); onEdit?.(message.id, draft); }}
                  disabled={!draft.trim()}
                  className="px-2 py-1 rounded bg-brand text-white hover:bg-brand-hover disabled:opacity-40 transition"
                >
                  Resend
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="inline-flex flex-col items-end gap-2">
                {message.images && message.images.length > 0 && (
                  <ImageStrip images={message.images} />
                )}
                {message.content && (
                  <div className="rounded-lg rounded-tr-sm px-3 py-2 bg-brand text-white text-xs leading-relaxed chat-part-in">
                    <span className="whitespace-pre-line break-words">{message.content}</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition">
                {onEdit && !streaming && (
                  <button
                    onClick={() => { setDraft(message.content); setEditing(true); }}
                    title="Edit & resend"
                    className="text-[10px] text-txt-tertiary hover:text-txt-primary flex items-center gap-1 min-h-8 px-1"
                  >
                    <Pencil className="w-3 h-3" /> edit
                  </button>
                )}
                {onRestart && !streaming && (
                  <button
                    onClick={() => onRestart(message.id)}
                    title="Restart task from this message (deletes subsequent agent turns)"
                    className="text-[10px] text-txt-tertiary hover:text-txt-primary flex items-center gap-1 min-h-8 px-1"
                  >
                    <RotateCcw className="w-3 h-3" /> restart from here
                  </button>
                )}
              </div>
            </>
          )
        ) : (
          <div className="min-w-0 space-y-2">
            {parts.map((part, i) => {
              const isLast = i === parts.length - 1;
              if (part.type === 'reasoning') {
                return (
                  <div key={part.id} className="chat-part-in">
                    <ReasoningPanel
                      text={part.text}
                      thinking={streaming && isLast && part.type === 'reasoning' && !hasText}
                    />
                  </div>
                );
              }
              if (part.type === 'tool') {
                return (
                  <div key={part.tool.id} className="chat-part-in">
                    <ToolBlock tool={part.tool} />
                  </div>
                );
              }
              return (
                <div key={`text-${i}`} className="chat-part-in text-xs leading-relaxed text-txt-primary max-w-none">
                  <Markdown content={part.text} />
                  {streaming && isLast && <StreamingCaret />}
                </div>
              );
            })}
            {waiting && (
              <div className="flex items-center gap-2 text-xs text-txt-tertiary chat-part-in">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Thinking…</span>
              </div>
            )}
          </div>
        )}
      </div>

      {!isUser && !streaming && (
        <div className="mt-1 flex items-center gap-2">
          {message.content && <CopyButton text={message.content} />}
          {onRegenerate && (
            <button
              onClick={() => onRegenerate(message.id)}
              title="Regenerate this response"
              className="text-[10px] text-txt-tertiary hover:text-txt-primary flex items-center gap-1 py-1 px-1.5 rounded hover:bg-surface-subtle transition"
            >
              <RotateCcw className="w-3 h-3" /> regenerate
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const ReasoningPanel: React.FC<{ text: string; thinking: boolean }> = ({ text, thinking }) => {
  const [open, setOpen] = useState(thinking);
  const wasThinking = useRef(thinking);

  useEffect(() => {
    if (thinking && !wasThinking.current) setOpen(true);
    if (!thinking && wasThinking.current) setOpen(false);
    wasThinking.current = thinking;
  }, [thinking]);

  return (
    <div className="max-w-full">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 text-[11px] font-medium transition ${
          thinking ? 'text-brand' : 'text-txt-tertiary hover:text-txt-secondary'
        }`}
        title={open ? 'Collapse reasoning' : 'Expand reasoning'}
      >
        <Brain className={`w-3.5 h-3.5 ${thinking ? 'animate-pulse' : ''}`} />
        <span>{thinking ? 'Thinking…' : 'Thought process'}</span>
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      <div
        className={`overflow-hidden transition-all duration-200 ${
          open ? 'max-h-96 overflow-y-auto opacity-100 mt-1.5' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="border-l-2 border-brand/30 pl-3 ml-1.5 py-1">
          <p className="text-[11px] text-txt-secondary italic leading-relaxed whitespace-pre-line">{text}</p>
        </div>
      </div>
    </div>
  );
};

const StreamingCaret: React.FC = () => (
  <span className="inline-block w-1.5 h-3.5 ml-0.5 align-text-bottom bg-brand animate-pulse rounded-sm" />
);

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      }}
      title="Copy reply"
      className="p-1 rounded text-txt-tertiary hover:text-txt-primary hover:bg-surface-subtle transition"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-txt-open" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

export const ToolBlockView: React.FC<{ tool: ToolCall }> = ({ tool }) => (
  <ToolBlock tool={tool} />
);

interface ToolBlockProps {
  tool: ToolCall;
}

const ToolBlock: React.FC<ToolBlockProps> = ({ tool }) => {
  const shown = tool.name === 'show_images' && tool.output ? parseShownImages(tool.output) : [];
  const [open, setOpen] = useState(shown.length > 0);
  const hasShownImages = shown.length > 0;
  useEffect(() => {
    if (hasShownImages) setOpen(true);
  }, [hasShownImages]);
  return (
    <div className="rounded-md border border-border-subtle bg-surface-base overflow-hidden max-w-xl">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono hover:bg-surface-subtle/40 transition"
      >
        <span className="flex items-center gap-2 truncate">
          {tool.status === 'approval' ? (
            <span className="text-brand" aria-hidden="true">?</span>
          ) : tool.status === 'running' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" />
          ) : tool.status === 'success' ? (
            <Check className="w-3.5 h-3.5 text-txt-open" />
          ) : (
            <XCircle className="w-3.5 h-3.5 text-feedback-error-text" />
          )}
          <span className="text-txt-primary">{tool.name}</span>
          {tool.status === 'approval' && <span className="text-brand">Approval needed</span>}
          {tool.argsText && tool.argsText !== '{}' && (
            <span className="text-txt-tertiary truncate max-w-[16rem]">{tool.argsText}</span>
          )}
        </span>
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-txt-tertiary shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-txt-tertiary shrink-0" />
        )}
      </button>
      {tool.status === 'approval' && tool.approvalId && tool.conversationId && <CommandApproval key={tool.approvalId} tool={tool} />}
      {open && shown.length > 0 && (
        <div className="px-3 pb-3 pt-1">
          <ImageStrip images={shown} />
        </div>
      )}
      {open && shown.length === 0 && tool.output != null && (
        <pre className="px-3 pb-2 text-[11px] font-mono text-txt-secondary overflow-x-auto whitespace-pre leading-relaxed">
          {tool.output}
        </pre>
      )}
    </div>
  );
};

export const ImageStrip: React.FC<{ images: ChatImage[] }> = ({ images }) => {
  const [lightbox, setLightbox] = useState<ChatImage | null>(null);
  const closeLightbox = useCallback(() => setLightbox(null), []);
  if (!images.length) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {images.map(img => {
          if (!isImageAttachment(img)) {
            return (
              <a
                key={img.id}
                href={img.dataUrl}
                download={img.name || 'attachment'}
                className="group flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-base hover:border-border-mid transition px-3 py-2"
                title={img.name || 'Download attachment'}
              >
                <FileText className="w-4 h-4 text-txt-secondary shrink-0" />
                <span className="text-xs font-mono text-txt-secondary truncate max-w-[12rem]">{img.name || 'attachment'}</span>
              </a>
            );
          }
          return (
            <button
              key={img.id}
              type="button"
              onClick={event => {
                event.currentTarget.focus();
                setLightbox(img);
              }}
              className="group relative rounded-lg overflow-hidden border border-border-subtle bg-surface-base hover:border-border-mid transition"
              title={img.name || 'Open image'}
            >
              <img src={img.dataUrl} alt={img.name || 'attached'} className="max-h-40 max-w-[14rem] object-contain block" />
              {img.name && (
                <span className="absolute bottom-0 inset-x-0 px-1.5 py-0.5 text-[10px] font-mono text-txt-secondary bg-surface-canvas/80 truncate">
                  {img.name}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {lightbox && <ImagePreview image={lightbox} onClose={closeLightbox} />}
    </>
  );
};

const ImagePreview: React.FC<{ image: ChatImage; onClose: () => void }> = ({ image, onClose }) => {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === 'Tab') {
        // The close button is the preview's only interactive element.
        event.preventDefault();
        event.stopPropagation();
        closeButton.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [onClose]);

  // Animated message wrappers establish a containing block and tool cards clip
  // overflow. A body portal keeps the backdrop and close control viewport-wide.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.name ? `Image preview: ${image.name}` : 'Image preview'}
      className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-6 pt-16"
      onClick={event => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        ref={closeButton}
        type="button"
        aria-label="Close image preview"
        onClick={onClose}
        className="absolute top-3 right-3 flex items-center justify-center w-11 h-11 rounded-full bg-black/60 text-white hover:bg-black/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
      >
        <X className="w-6 h-6" aria-hidden="true" />
      </button>
      <img
        src={image.dataUrl}
        alt={image.name || 'preview'}
        className="max-h-full max-w-full object-contain rounded-md shadow-2xl"
      />
    </div>,
    document.body,
  );
};
