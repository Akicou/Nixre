import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Send,
  Plus,
  Trash2,
  Bot,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
  User,
  XCircle
} from 'lucide-react';
import { getPlugin } from '../../lib/plugins';
import { isRealAi, type AssistantProviderProfile } from '../../lib/assistantProfiles';
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  runTurn,
  runRealTurn,
  uid,
  type ChatMessage,
  type Conversation,
  type EngineEvent,
} from '../../lib/assistantEngine';
import { Markdown } from '../Markdown';

interface ChatSurfaceProps {
  repoPath: string;
  profile: AssistantProviderProfile;
  // Context title shown in the panel header (repo name, PR title, ...).
  title?: string;
  // Shown when this surface is a slide-in panel that can be closed.
  onClose?: () => void;
  // Suggest prompt chips shown on the empty state.
  suggestions?: string[];
}

const EMPTY_STATE_SUGGESTIONS = [
  'Review this change for regressions',
  'Run the tests and lint',
  'Scan for exposed secrets',
  'Explain what this repo does',
];

function applyEvent(messages: ChatMessage[], ev: EngineEvent): ChatMessage[] {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    // No assistant message yet for this turn — create one so the first
    // streamed event (reasoning / tool) has a target to append to.
    const msg: ChatMessage = { id: uid('msg'), role: 'assistant', content: '', createdAt: Date.now() };
    messages = [...messages, msg];
    idx = messages.length - 1;
  }
  const message = { ...messages[idx] };
  switch (ev.type) {
    case 'reasoning':
      message.reasoning = [...(message.reasoning ?? []), { id: ev.blockId, text: ev.text }];
      break;
    case 'tool_start':
      message.toolCalls = [...(message.toolCalls ?? []), ev.tool];
      break;
    case 'tool_output':
      message.toolCalls = (message.toolCalls ?? []).map(t =>
        t.id === ev.toolId ? { ...t, status: 'success' as const, output: ev.output } : t,
      );
      break;
    case 'message_text':
      message.content = (message.content ?? '') + ev.text;
      break;
    default:
      break;
  }
  const next = messages.slice();
  next[idx] = message;
  return next;
}

export const ChatSurface: React.FC<ChatSurfaceProps> = ({
  repoPath,
  profile,
  title,
  onClose,
  suggestions = EMPTY_STATE_SUGGESTIONS,
}) => {
  const assistant = getPlugin('nixre-assistant');
  const reasoningField = assistant?.providerFields?.find(f => f.key === 'reasoningLevel');
  const reasoningOptions = reasoningField?.options ?? ['none', 'low', 'medium', 'high'];

  // Real mode needs a validated provider; otherwise the mock engine runs
  // and the UI says so.
  const realAi = isRealAi(profile);
  // Model options come from the live provider list (server-fetched cache).
  // No provider configured -> no models at all: the picker is disabled and
  // shows why instead of offering a meaningless default.
  const modelOptions = profile.models;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  const [workingModel, setWorkingModel] = useState(profile.model);
  const [workingReasoning, setWorkingReasoning] = useState(profile.reasoningLevel);
  const [modelOpen, setModelOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);

  const current = conversations.find(c => c.id === currentId);

  const refreshConversations = () => {
    listConversations(repoPath).then(setConversations).catch(() => {});
  };

  // Conversations load from the sync backend on mount / repo change.
  useEffect(() => {
    setConversations([]);
    setCurrentId(null);
    setMessages([]);
    listConversations(repoPath).then(setConversations).catch(() => setConversations([]));
  }, [repoPath]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
      if (reasoningRef.current && !reasoningRef.current.contains(e.target as Node)) setReasoningOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const startNewChat = () => {
    setCurrentId(null);
    setMessages([]);
    setInput('');
  };

  const loadConversation = (conv: Conversation) => {
    setCurrentId(conv.id);
    setMessages(conv.messages);
    setInput('');
  };

  const send = async (text?: string) => {
    const prompt = (text ?? input).trim();
    if (!prompt || streaming) return;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    setStreaming(true);
    let convId = currentId;
    let title = current?.title ?? prompt.slice(0, 48);
    try {
      if (!convId) {
        const conv = await createConversation(repoPath, prompt.slice(0, 48));
        convId = conv.id;
        title = conv.title;
        setCurrentId(conv.id);
        refreshConversations();
      }

      const userMessage: ChatMessage = {
        id: uid('u'),
        role: 'user',
        content: prompt,
        createdAt: Date.now(),
      };
      // Accumulate locally: `messages` from the closure would go stale across
      // awaits inside the streaming loop below.
      let local: ChatMessage[] = [...messages, userMessage];
      setMessages(local);
      await updateConversation({ id: convId, repoPath, title, messages: local, updatedAt: Date.now() });

      const workingProfile: AssistantProviderProfile = {
        ...profile,
        model: workingModel,
        reasoningLevel: workingReasoning,
      };

      if (realAi) {
        // Real turn: stream the actual model through nixre-core's proxy.
        const history = messages
          .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content))
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
        try {
          for await (const ev of runRealTurn(prompt, workingProfile, history, {
            model: workingModel,
            reasoningLevel: workingReasoning,
          })) {
            local = applyEvent(local, ev);
            setMessages(local);
          }
        } catch (err: any) {
          local = applyEvent(local, {
            type: 'message_text',
            text: `\n\n> ⚠️ ${err.message || 'The AI provider request failed.'}`,
          });
          setMessages(local);
        }
      } else {
        // Demo turn: deterministic mock agent.
        for await (const ev of runTurn(prompt, workingProfile, 35)) {
          local = applyEvent(local, ev);
          setMessages(local);
        }
      }
      await updateConversation({ id: convId, repoPath, title, messages: local, updatedAt: Date.now() });
    } catch {
      // Backend unreachable — the turn still rendered locally; surface nothing
      // extra here, the sidebar refresh below will reflect the true state.
    } finally {
      setStreaming(false);
      refreshConversations();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Only meaningful when models exist; the no-provider branch renders its
  // own label instead of reading this.
  const activeModelLabel = modelOptions.includes(workingModel)
    ? workingModel
    : modelOptions[0] ?? '';

  return (
    <div className="flex h-full min-h-0 bg-surface-base">
      {/* History sidebar */}
      <aside className="hidden sm:flex flex-col w-60 shrink-0 min-h-0 border-r border-border-subtle bg-surface-canvas">
        <div className="flex items-center justify-between p-3 border-b border-border-subtle">
          <span className="text-xs font-semibold text-txt-primary uppercase tracking-wider flex items-center gap-1.5">
            <Bot className="w-4 h-4 text-brand" />
            Assistant
          </span>
          <button
            onClick={startNewChat}
            title="New chat"
            className="p-1.5 rounded hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {conversations.length === 0 ? (
            <p className="text-[11px] text-txt-tertiary px-2 py-2">No chats for this repo yet.</p>
          ) : (
            conversations.map(c => (
              <div
                key={c.id}
                className={`group flex items-center justify-group-between rounded px-2 py-1.5 text-xs cursor-pointer transition ${
                  c.id === currentId ? 'bg-surface-subtle text-txt-primary' : 'text-txt-secondary hover:bg-surface-subtle/60'
                }`}
                onClick={() => loadConversation(c)}
              >
                <span className="truncate pr-1">{c.title || 'Untitled'}</span>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    deleteConversation(c.id)
                      .then(() => {
                        if (currentId === c.id) startNewChat();
                      })
                      .catch(() => {})
                      .finally(refreshConversations);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-feedback-error-bg text-txt-tertiary hover:text-feedback-error-text transition shrink-0"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface-canvas">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-txt-primary truncate">
              <Sparkles className="w-4 h-4 text-brand shrink-0" />
              <span>{title || repoPath}</span>
            </div>
            <p className="text-[11px] text-txt-tertiary truncate">
              Nixre Assistant • {profile.provider}
              {!realAi && <span className="text-feedback-warn-text"> • demo mode</span>}
            </p>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 rounded hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center px-6 text-center">
              <div className="w-12 h-12 rounded-xl bg-surface-subtle border border-border-subtle flex items-center justify-center mb-4">
                <Bot className="w-6 h-6 text-brand" />
              </div>
              <h2 className="text-base font-semibold text-txt-primary mb-1">How can I help in {repoPath}?</h2>
              <p className="text-xs text-txt-secondary max-w-md mb-6">
                I read files, run the build and tests, search the web, and — with your access profile — can edit, commit and open PRs.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg w-full">
                {suggestions.map(s => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="text-left text-xs px-3 py-2 rounded-md border border-border-subtle bg-surface-base text-txt-secondary hover:border-brand hover:text-txt-primary transition"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
              {messages.map(msg => (
                <Message key={msg.id} message={msg} openTools={openTools} onToggleTool={setOpenTools} />
              ))}
              {streaming && !messages.some(m => m.role === 'assistant' && m.content) && (
                <div className="flex items-center gap-2 text-xs text-txt-tertiary">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Thinking…</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-border-subtle bg-surface-canvas p-3">
          {/* Model + reasoning pickers */}
          <div className="flex items-center gap-2 max-w-3xl mx-auto mb-2 flex-wrap">
            <div ref={modelRef} className="relative">
              {modelOptions.length > 0 ? (
                <button
                  onClick={() => { setModelOpen(!modelOpen); setReasoningOpen(false); }}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border-subtle bg-surface-base text-txt-primary hover:border-brand transition"
                >
                  <span className="hidden sm:inline">Model:</span>
                  <span className="font-mono">{activeModelLabel}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-txt-tertiary" />
                </button>
              ) : (
                <Link
                  to="/plugins"
                  title="Configure an AI provider to enable model selection"
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border-subtle bg-surface-base text-txt-tertiary cursor-not-allowed"
                  onClick={e => {
                    if (realAi) e.preventDefault();
                  }}
                >
                  <span className="hidden sm:inline">Model:</span>
                  <span className="italic">no provider configured</span>
                </Link>
              )}
              {modelOpen && modelOptions.length > 0 && (
                <div className="absolute left-0 bottom-8 w-56 rounded-md border border-border-mid bg-surface-canvas shadow-xl py-1 z-30 animate-pop max-h-64 overflow-y-auto">
                  {modelOptions.map(m => (
                    <button
                      key={m}
                      onClick={() => { setWorkingModel(m); setModelOpen(false); }}
                      className={`w-full text-left px-3 py-1.5 text-xs font-mono transition ${
                        m === workingModel ? 'bg-surface-subtle text-txt-primary font-semibold' : 'text-txt-secondary hover:bg-surface-subtle/60'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div ref={reasoningRef} className="relative">
              <button
                onClick={() => { setReasoningOpen(!reasoningOpen); setModelOpen(false); }}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border-subtle bg-surface-base text-txt-primary hover:border-brand transition"
              >
                <span className="hidden sm:inline">Reasoning:</span>
                <span className="font-mono capitalize">{workingReasoning}</span>
                <ChevronDown className="w-3.5 h-3.5 text-txt-tertiary" />
              </button>
              {reasoningOpen && (
                <div className="absolute left-0 bottom-8 w-40 rounded-md border border-border-mid bg-surface-canvas shadow-xl py-1 z-30 animate-pop">
                  {reasoningOptions.map(r => (
                    <button
                      key={r}
                      onClick={() => { setWorkingReasoning(r); setReasoningOpen(false); }}
                      className={`w-full text-left px-3 py-1.5 text-xs capitalize transition ${
                        r === workingReasoning ? 'bg-surface-subtle text-txt-primary font-semibold' : 'text-txt-secondary hover:bg-surface-subtle/60'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {current && (
              <button
                onClick={startNewChat}
                className="text-xs px-2.5 py-1 rounded-md text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                New chat
              </button>
            )}
          </div>

          <div className="flex items-end gap-2 max-w-3xl mx-auto">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={e => {
                setInput(e.target.value);
                const el = e.target;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 160) + 'px';
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask the assistant anything…"
              className="flex-1 resize-none px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono placeholder:text-txt-tertiary focus:border-brand outline-none transition max-h-40"
              disabled={streaming}
            />
            <button
              onClick={() => send()}
              disabled={streaming || !input.trim()}
              className="p-2.5 rounded-md bg-brand text-white hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm shrink-0"
              title="Send"
            >
              {streaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface MessageProps {
  message: ChatMessage;
  openTools: Record<string, boolean>;
  onToggleTool: (tools: Record<string, boolean>) => void;
}

const Message: React.FC<MessageProps> = ({ message, openTools, onToggleTool }) => {
  const isUser = message.role === 'user';
  return (
    <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
        isUser ? 'bg-brand text-white' : 'bg-surface-subtle border border-border-subtle text-brand'
      }`}>
        {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
      </div>
      <div className={`flex-1 min-w-0 ${isUser ? 'text-right' : 'text-left'}`}>
        <div className={`inline-block text-left max-w-full rounded-lg px-3 py-2 ${
          isUser ? 'bg-brand text-white' : 'bg-surface-canvas border border-border-subtle'
        }`}>
          {message.reasoning && message.reasoning.length > 0 && (
            <div className="space-y-1.5 my-2 border-l-2 border-brand/40 pl-3 pr-2 py-1 bg-brand/5 rounded-r">
              {message.reasoning.map(r => (
                <p key={r.id} className="text-[11px] text-txt-secondary italic leading-relaxed">{r.text}</p>
              ))}
            </div>
          )}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="space-y-1.5 my-2">
              {message.toolCalls.map(tool => (
                <ToolBlock
                  key={tool.id}
                  tool={tool}
                  open={openTools[tool.id] ?? false}
                  onToggle={open => onToggleTool({ ...openTools, [tool.id]: open })}
                />
              ))}
            </div>
          )}
          <div className={`text-xs leading-relaxed ${isUser ? 'text-white' : 'text-txt-primary markdown-body'}`}>
            {isUser ? <span className="whitespace-pre-line">{message.content}</span> : <Markdown content={message.content} />}
          </div>
        </div>
      </div>
    </div>
  );
};

interface ToolBlockProps {
  tool: { id: string; name: string; status: 'running' | 'success' | 'error'; output?: string };
  open: boolean;
  onToggle: (open: boolean) => void;
}

const ToolBlock: React.FC<ToolBlockProps> = ({ tool, open, onToggle }) => (
  <div className="rounded-md border border-border-subtle bg-surface-base overflow-hidden">
    <button
      onClick={() => onToggle(!open)}
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
      {open ? <ChevronDown className="w-3.5 h-3.5 text-txt-tertiary" /> : <ChevronRight className="w-3.5 h-3.5 text-txt-tertiary" />}
    </button>
    {open && tool.output != null && (
      <pre className="px-3 pb-2 text-[11px] font-mono text-txt-secondary overflow-x-auto whitespace-pre leading-relaxed">
        {tool.output}
      </pre>
    )}
  </div>
);
