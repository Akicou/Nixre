import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  ListChecks,
  Loader2,
  Pencil,
  RotateCcw,
  Search,
  Terminal,
  X,
  XCircle,
} from 'lucide-react';
import type { ChatMessage, ToolCall } from '../../lib/assistantEngine';
import { messageParts } from '../../lib/assistantEngine';
import {
  countWork,
  describeTool,
  editedFiles,
  groupParts,
  summarizeWork,
  totalChanges,
  type EditedFile,
  type StepKind,
  type WorkItem,
} from '../../lib/workSummary';
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
  const blocks = groupParts(parts);
  const edited = !isUser && !streaming ? editedFiles(parts) : [];
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
                  <div className="rounded-2xl rounded-tr-md px-4 py-2.5 bg-surface-subtle border border-border-subtle text-txt-primary text-[13px] leading-relaxed chat-part-in">
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
          <div className="min-w-0 space-y-3">
            {blocks.map((block, bi) => {
              const isLast = bi === blocks.length - 1;
              if (block.kind === 'work') {
                return (
                  <div key={block.key} className="chat-part-in">
                    <WorkGroup items={block.items} live={streaming && isLast} thinkingTail={streaming && isLast && !hasText} />
                  </div>
                );
              }
              return (
                <div key={block.key} className="chat-part-in text-[13.5px] leading-[1.7] text-txt-primary max-w-none">
                  <Markdown content={block.text} />
                  {streaming && isLast && <StreamingCaret />}
                </div>
              );
            })}
            {edited.length > 0 && <EditedFilesCard files={edited} />}
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
        <div className="mt-2 flex items-center gap-1.5 text-txt-tertiary">
          {message.content && <CopyButton text={message.content} />}
          {onRegenerate && (
            <button
              onClick={() => onRegenerate(message.id)}
              title="Regenerate this response"
              className="text-[11px] text-txt-tertiary hover:text-txt-primary flex items-center gap-1 py-1 px-1.5 rounded hover:bg-surface-subtle transition"
            >
              <RotateCcw className="w-3 h-3" /> regenerate
            </button>
          )}
          {clock(message.createdAt) && <span className="ml-1 text-[11px] tabular-nums">{clock(message.createdAt)}</span>}
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

const STEP_ICON: Record<StepKind, React.FC<{ className?: string }>> = {
  read: FileText,
  search: Search,
  edit: Pencil,
  run: Terminal,
  other: ListChecks,
};

/** One quiet line per tool call. Click to see the raw output. */
const ToolBlock: React.FC<ToolBlockProps> = ({ tool }) => {
  const shown = tool.name === 'show_images' && tool.output ? parseShownImages(tool.output) : [];
  const [open, setOpen] = useState(shown.length > 0);
  const hasShownImages = shown.length > 0;
  useEffect(() => {
    if (hasShownImages) setOpen(true);
  }, [hasShownImages]);
  const step = describeTool(tool);
  const Icon = STEP_ICON[step.kind];
  const showArgs = !step.subject && tool.status !== 'approval' && tool.argsText && tool.argsText !== '{}';
  return (
    <div className="max-w-full">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="group w-full flex items-center gap-2 py-1 text-left text-[12px] text-txt-secondary hover:text-txt-primary transition"
      >
        {tool.status === 'approval' ? (
          <span className="w-3.5 text-center text-brand" aria-hidden="true">?</span>
        ) : tool.status === 'running' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-brand shrink-0" />
        ) : tool.status === 'success' ? (
          <Icon className="w-3.5 h-3.5 text-txt-tertiary shrink-0" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-feedback-error-text shrink-0" />
        )}
        <span className="shrink-0">{step.verb}</span>
        {step.subject && tool.status !== 'approval' && <span className="font-mono text-[11.5px] text-txt-tertiary truncate max-w-[26rem]">{step.subject}</span>}
        {showArgs && <span className="font-mono text-[11.5px] text-txt-tertiary truncate max-w-[26rem]">{tool.argsText}</span>}
        {tool.status === 'approval' && <span className="text-brand shrink-0">Approval needed</span>}
        {open ? (
          <ChevronDown className="w-3 h-3 text-txt-tertiary shrink-0 ml-auto" />
        ) : (
          <ChevronRight className="w-3 h-3 text-txt-tertiary shrink-0 ml-auto opacity-0 group-hover:opacity-100 transition" />
        )}
      </button>
      {tool.status === 'approval' && tool.approvalId && tool.conversationId && <CommandApproval key={tool.approvalId} tool={tool} />}
      {open && shown.length > 0 && (
        <div className="pb-2 pt-1">
          <ImageStrip images={shown} />
        </div>
      )}
      {open && shown.length === 0 && tool.output != null && (
        <pre className="mt-1 mb-2 rounded-lg border border-border-subtle bg-surface-base px-3 py-2 text-[11px] font-mono text-txt-secondary overflow-x-auto whitespace-pre leading-relaxed max-h-64 overflow-y-auto">
          {tool.output}
        </pre>
      )}
    </div>
  );
};

/**
 * Consecutive reasoning and tool steps, folded into one disclosure. Open while
 * the agent works or when something needs the user (approval), folded after.
 */
const WorkGroup: React.FC<{ items: WorkItem[]; live: boolean; thinkingTail: boolean }> = ({ items, live, thinkingTail }) => {
  const counts = countWork(items);
  const attention = counts.pending > 0 && items.some(i => i.type === 'tool' && i.tool.status === 'approval');
  const [open, setOpen] = useState(live || attention);
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current) setOpen(true);
    if (!live && wasLive.current && !attention) setOpen(false);
    wasLive.current = live;
  }, [live, attention]);
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);
  const summary = summarizeWork(counts);
  const label = live ? 'Working…' : counts.steps > 0 ? `Worked on ${counts.steps} ${counts.steps === 1 ? 'step' : 'steps'}` : 'Thought process';
  const lastIndex = items.length - 1;
  return (
    <div className="max-w-full" data-testid="work-group">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className={`flex items-center gap-2 text-[12px] transition ${live ? 'text-brand' : 'text-txt-tertiary hover:text-txt-secondary'}`}
      >
        {live ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ListChecks className="w-3.5 h-3.5" />}
        <span className="font-medium">{label}</span>
        {summary && !live && <span className="hidden sm:inline text-txt-tertiary">· {summary}</span>}
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
      {open && (
        <div className="mt-1.5 ml-[7px] border-l border-border-subtle pl-4 space-y-0.5">
          {items.map((item, i) =>
            item.type === 'reasoning' ? (
              <ReasoningPanel key={item.id} text={item.text} thinking={thinkingTail && i === lastIndex} />
            ) : (
              <ToolBlock key={item.tool.id} tool={item.tool} />
            ),
          )}
        </div>
      )}
    </div>
  );
};

/** "Edited 3 files +14 -2" with one row per file. */
const EditedFilesCard: React.FC<{ files: EditedFile[] }> = ({ files }) => {
  const [all, setAll] = useState(false);
  const total = totalChanges(files);
  const shown = all ? files : files.slice(0, 4);
  const counts = (f: { added: number | null; removed: number | null }) =>
    f.added === null || f.removed === null ? null : (
      <span className="font-mono text-[11px] tabular-nums shrink-0">
        <span className="text-txt-open">+{f.added}</span> <span className="text-feedback-error-text">-{f.removed}</span>
      </span>
    );
  return (
    <div className="rounded-xl border border-border-subtle bg-surface-canvas overflow-hidden chat-part-in" data-testid="edited-files">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border-subtle">
        <Pencil className="w-4 h-4 text-txt-secondary shrink-0" />
        <span className="text-[13px] font-medium text-txt-primary">
          Edited {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
        {(total.added > 0 || total.removed > 0) && (
          <span className="ml-auto font-mono text-[11px] tabular-nums">
            <span className="text-txt-open">+{total.added}</span> <span className="text-feedback-error-text">-{total.removed}</span>
          </span>
        )}
      </div>
      <ul className="divide-y divide-border-subtle">
        {shown.map(f => (
          <li key={f.path} className="flex items-center justify-between gap-3 px-4 py-2 text-[12px]">
            <span className="font-mono text-txt-secondary truncate">{f.path}</span>
            {counts(f)}
          </li>
        ))}
      </ul>
      {files.length > 4 && (
        <button
          onClick={() => setAll(a => !a)}
          className="w-full flex items-center gap-1 px-4 py-2 border-t border-border-subtle text-[12px] text-txt-tertiary hover:text-txt-primary hover:bg-surface-subtle transition"
        >
          {all ? 'Show fewer' : `All ${files.length} files`}
          <ChevronDown className={`w-3 h-3 ${all ? 'rotate-180' : ''}`} />
        </button>
      )}
    </div>
  );
};

function clock(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

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
