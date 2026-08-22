import React, { useEffect, useRef, useState } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Pencil,
  XCircle,
} from 'lucide-react';
import type { ChatMessage, ToolCall } from '../../lib/assistantEngine';
import { messageParts } from '../../lib/assistantEngine';
import { Markdown } from '../Markdown';
import { parseShownImages, type ChatImage } from '../../lib/chatImages';

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
}

export const ChatMessageView: React.FC<ChatMessageViewProps> = ({ message, streaming = false, onEdit }) => {
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
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
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
              {onEdit && !streaming && (
                <button
                  onClick={() => { setDraft(message.content); setEditing(true); }}
                  title="Edit & resend"
                  className="mt-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition text-[10px] text-txt-tertiary hover:text-txt-primary flex items-center gap-1 min-h-11 px-1"
                >
                  <Pencil className="w-3 h-3" /> edit &amp; resend
                </button>
              )}
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
                <div key={`text-${i}`} className="chat-part-in text-xs leading-relaxed text-txt-primary markdown-body max-w-none">
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

      {!isUser && !streaming && message.content && (
        <div className="mt-1">
          <CopyButton text={message.content} />
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
          open ? 'max-h-96 opacity-100 mt-1.5' : 'max-h-0 opacity-0'
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
  return (
    <div className="rounded-md border border-border-subtle bg-surface-base overflow-hidden max-w-xl">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono hover:bg-surface-subtle/40 transition"
      >
        <span className="flex items-center gap-2 truncate">
          {tool.status === 'running' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" />
          ) : tool.status === 'success' ? (
            <Check className="w-3.5 h-3.5 text-txt-open" />
          ) : (
            <XCircle className="w-3.5 h-3.5 text-feedback-error-text" />
          )}
          <span className="text-txt-primary">{tool.name}</span>
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
  if (!images.length) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {images.map(img => (
          <button
            key={img.id}
            type="button"
            onClick={() => setLightbox(img)}
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
        ))}
      </div>
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox.dataUrl}
            alt={lightbox.name || 'preview'}
            className="max-h-[90vh] max-w-[90vw] object-contain rounded-md shadow-2xl"
          />
        </div>
      )}
    </>
  );
};
