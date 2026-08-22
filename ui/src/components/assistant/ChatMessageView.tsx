import React, { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  User,
  XCircle,
} from 'lucide-react';
import type { ChatMessage, ToolCall } from '../../lib/assistantEngine';
import { Markdown } from '../Markdown';

/**
 * Shared renderer for a single chat turn — used by the repo ChatSurface and
 * the dashboard HomeChat so both stay visually identical.
 *
 * Assistant reasoning renders as a collapsible ("extendable & compactable")
 * block: it auto-expands while the model is thinking, then folds down to a
 * one-line "Thought process" header once answer text starts streaming.
 */

interface ChatMessageViewProps {
  message: ChatMessage;
  /** True while this message is still receiving streamed events. */
  streaming?: boolean;
}

export const ChatMessageView: React.FC<ChatMessageViewProps> = ({ message, streaming = false }) => {
  const isUser = message.role === 'user';
  const hasReasoning = !isUser && (message.reasoning?.length ?? 0) > 0;
  const thinking =
    streaming && !message.content && ((message.reasoning?.length ?? 0) > 0 || !hasReasoning);

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div
        className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5 ${
          isUser
            ? 'bg-brand text-white'
            : 'bg-surface-subtle border border-border-subtle text-brand'
        }`}
      >
        {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-4 h-4" />}
      </div>

      <div className={`min-w-0 flex-1 ${isUser ? 'flex flex-col items-end' : ''}`}>
        {!isUser && hasReasoning && <ReasoningPanel message={message} thinking={thinking} />}

        {isUser ? (
          <div className="inline-block max-w-[85%] rounded-lg rounded-tr-sm px-3 py-2 bg-brand text-white text-xs leading-relaxed">
            <span className="whitespace-pre-line break-words">{message.content}</span>
          </div>
        ) : (
          <div className="min-w-0">
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="space-y-1.5 mb-2">
                {message.toolCalls.map(tool => (
                  <ToolBlock key={tool.id} tool={tool} />
                ))}
              </div>
            )}
            {message.content ? (
              <div className="text-xs leading-relaxed text-txt-primary markdown-body max-w-none">
                <Markdown content={message.content} />
                {streaming && <StreamingCaret />}
              </div>
            ) : (
              !hasReasoning &&
              streaming && (
                <div className="flex items-center gap-2 text-xs text-txt-tertiary">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Thinking…</span>
                </div>
              )
            )}
          </div>
        )}
      </div>

      {!isUser && !streaming && message.content && <CopyButton text={message.content} />}
    </div>
  );
};

/** Collapsible reasoning — expanded while thinking starts, folded after. */
const ReasoningPanel: React.FC<{ message: ChatMessage; thinking: boolean }> = ({
  message,
  thinking,
}) => {
  // Open while there is only thinking to show; fold automatically once the
  // actual answer arrives. The user can always re-expand.
  const [open, setOpen] = useState(thinking);
  const wasThinking = useRef(thinking);

  useEffect(() => {
    if (thinking && !wasThinking.current) setOpen(true);
    if (!thinking && wasThinking.current) setOpen(false);
    wasThinking.current = thinking;
  }, [thinking]);

  return (
    <div className="mb-2 max-w-full">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 text-[11px] font-medium transition ${
          thinking ? 'text-brand' : 'text-txt-tertiary hover:text-txt-secondary'
        }`}
        title={open ? 'Collapse reasoning' : 'Expand reasoning'}
      >
        <Brain className={`w-3.5 h-3.5 ${thinking ? 'animate-pulse' : ''}`} />
        <span>{thinking ? 'Thinking…' : 'Thought process'}</span>
        {open ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronRight className="w-3 h-3" />
        )}
      </button>
      <div
        className={`overflow-hidden transition-all duration-200 ${
          open ? 'max-h-96 opacity-100 mt-1.5' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="border-l-2 border-brand/30 pl-3 ml-1.5 space-y-2 py-1">
          {message.reasoning!.map(block => (
            <p
              key={block.id}
              className="text-[11px] text-txt-secondary italic leading-relaxed whitespace-pre-line"
            >
              {block.text}
            </p>
          ))}
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
      className="self-start mt-1 p-1 rounded text-txt-tertiary hover:text-txt-primary hover:bg-surface-subtle transition"
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
  const [open, setOpen] = useState(false);
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
        </span>
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-txt-tertiary shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-txt-tertiary shrink-0" />
        )}
      </button>
      {open && tool.output != null && (
        <pre className="px-3 pb-2 text-[11px] font-mono text-txt-secondary overflow-x-auto whitespace-pre leading-relaxed">
          {tool.output}
        </pre>
      )}
    </div>
  );
};
