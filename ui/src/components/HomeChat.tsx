import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Send,
  Bot,
  Loader2,
  ChevronDown,
  Plus,
  Sparkles,
  Settings2,
  User,
} from 'lucide-react';
import {
  getActiveProviderProfile,
  isRealAi,
  type AssistantProviderProfile,
} from '../lib/assistantProfiles';
import {
  listConversations,
  createConversation,
  updateConversation,
  runRealTurn,
  applyEvent,
  uid,
  type ChatMessage,
  type Conversation,
} from '../lib/assistantEngine';
import { ASSISTANT_MODES, MODE_ACCENT_CLASSES, type ModeId } from '../lib/assistantModes';
import { Markdown } from './Markdown';

// The dashboard conversation bucket — not tied to a repo. Repo-bound chats
// live on the repo page; this one is for forge-wide questions and quick work.
const HOME_PATH = '~home';

const HOME_SUGGESTIONS = [
  'What should I work on next?',
  'Explain the branch layout of my repos',
  'Draft a PR description for my last change',
  'Help me set up CI for a repo',
];

/**
 * HomeChat — the assistant on the dashboard.
 *
 * Collapsed: a compact launcher (mode pills + fake input) sitting between the
 * repo list and the sidebar. On focus or first message it animatedly opens
 * into a full chat session (height + fade + slide), keeps the conversation
 * persisted server-side, and collapses back on demand. Fully responsive:
 * stacks with the page on mobile, max-height clamps on desktop.
 */
export const HomeChat: React.FC = () => {
  const [profile, setProfile] = useState<AssistantProviderProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [convoId, setConvoId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState<ModeId>('ask');
  const [modelOpen, setModelOpen] = useState(false);
  const [workingModel, setWorkingModel] = useState('');

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);

  const realAi = profile ? isRealAi(profile) : false;
  const modelOptions = profile?.models ?? [];

  // Load profile + the latest home conversation once.
  useEffect(() => {
    let cancelled = false;
    getActiveProviderProfile().then(p => {
      if (!cancelled) {
        setProfile(p);
        setWorkingModel(p.model);
      }
    }).catch(() => {});
    listConversations(HOME_PATH)
      .then(async (list: Conversation[]) => {
        if (cancelled || list.length === 0) return;
        // server list is newest-first; continue the latest session
        setConvoId(list[0].id);
        setMessages(list[0].messages);
        setOpen(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll while streaming.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Close the model dropdown on outside click.
  useEffect(() => {
    if (!modelOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [modelOpen]);

  const openSession = (focus = true) => {
    setOpen(true);
    if (focus) requestAnimationFrame(() => inputRef.current?.focus());
  };

  const send = async (text?: string) => {
    const prompt = (text ?? input).trim();
    if (!prompt || streaming || !profile || !realAi) return;
    setInput('');
    openSession(false);

    let id = convoId;
    let title = prompt.slice(0, 48);
    setStreaming(true);
    try {
      if (!id) {
        const conv = await createConversation(HOME_PATH, title);
        id = conv.id;
        title = conv.title;
        setConvoId(id);
      }

      const userMessage: ChatMessage = { id: uid('u'), role: 'user', content: prompt, createdAt: Date.now() };
      let local: ChatMessage[] = [...messages, userMessage];
      setMessages(local);
      await updateConversation({ id, repoPath: HOME_PATH, title, messages: local, updatedAt: Date.now() });

      const history = messages
        .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content))
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      try {
        for await (const ev of runRealTurn(prompt, { ...profile, model: workingModel || profile.model }, history, {
          model: workingModel || undefined,
          mode,
        })) {
          local = applyEvent(local, ev);
          setMessages(local);
        }
      } catch (err: any) {
        local = applyEvent(local, { type: 'message_text', text: `\n\n> ⚠️ ${err.message || 'The AI provider request failed.'}` });
        setMessages(local);
      }
      await updateConversation({ id, repoPath: HOME_PATH, title, messages: local, updatedAt: Date.now() });
    } catch {
      // persistence failure — the turn still rendered
    } finally {
      setStreaming(false);
    }
  };

  const startNew = () => {
    setConvoId(null);
    setMessages([]);
    setInput('');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const activeMode = ASSISTANT_MODES.find(m => m.id === mode)!;
  const accent = MODE_ACCENT_CLASSES[activeMode.accent];

  return (
    <div className="home-chat relative rounded-xl border border-border-subtle bg-surface-canvas overflow-hidden">
      {/* Ambient top glow — a whisper of the brand behind the header. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-brand/8 to-transparent" />

      {/* Header (always visible) */}
      <div className="relative flex items-center justify-between gap-2 px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-surface-subtle border border-border-subtle flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4 text-brand" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-txt-primary leading-tight">Nixre Assistant</h2>
            <p className="text-[11px] text-txt-tertiary truncate">
              {profile?.provider ?? '…'}
              {realAi ? <span className={accent.text}> · {activeMode.label}</span> : <span> · not configured</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {open && (
            <button
              onClick={startNew}
              title="New chat"
              className="p-1.5 rounded-md hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition"
            >
              <Plus className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => (open ? setOpen(false) : openSession())}
            title={open ? 'Collapse' : 'Open'}
            className="p-1.5 rounded-md hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition"
          >
            <ChevronDown className={`w-4 h-4 transition-transform duration-300 ${open ? '' : 'rotate-180'}`} />
          </button>
        </div>
      </div>

      {/* Expanding session body */}
      <div className={`home-chat-body ${open ? 'is-open' : ''}`}>
        <div className="overflow-hidden flex flex-col">
          {/* Messages / empty state */}
          <div ref={scrollRef} className="max-h-[380px] overflow-y-auto min-h-[120px] px-4 py-4">
            {messages.length === 0 ? (
              realAi ? (
                <div className="text-center py-4">
                  <p className="text-xs text-txt-secondary max-w-xs mx-auto">
                    Ask anything about your codebase — or pick a mode and put the assistant to work.
                  </p>
                  <div className="mt-3 grid gap-1.5 max-w-xs mx-auto">
                    {HOME_SUGGESTIONS.map(s => (
                      <button
                        key={s}
                        onClick={() => send(s)}
                        className="text-left text-[11px] px-3 py-1.5 rounded-md border border-border-subtle bg-surface-base text-txt-secondary hover:border-brand/50 hover:text-txt-primary transition"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center py-4">
                  <div className="w-10 h-10 rounded-xl bg-surface-subtle border border-border-subtle flex items-center justify-center mx-auto mb-3">
                    <Settings2 className="w-5 h-5 text-txt-tertiary" />
                  </div>
                  <p className="text-xs text-txt-secondary max-w-xs mx-auto">
                    The assistant needs a validated AI provider before it can chat.
                  </p>
                  <Link
                    to="/plugins"
                    className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-md bg-brand text-white text-[11px] font-medium hover:bg-brand-hover transition shadow-sm"
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    Configure a provider
                  </Link>
                </div>
              )
            ) : (
              <div className="space-y-4">
                {messages.map(msg => (
                  <HomeMessage key={msg.id} message={msg} />
                ))}
                {streaming && !messages.some(m => m.role === 'assistant' && m.content) && (
                  <div className="flex items-center gap-2 text-[11px] text-txt-tertiary">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Thinking…</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-border-subtle px-3 py-3 bg-surface-base/60">
            {/* Mode pills */}
            <div className="flex items-center gap-1.5 mb-2 flex-wrap">
              {ASSISTANT_MODES.map(m => {
                const active = m.id === mode;
                const a = MODE_ACCENT_CLASSES[m.accent];
                return (
                  <button
                    key={m.id}
                    onClick={() => setMode(m.id)}
                    title={m.description}
                    className={`flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full border transition ${
                      active
                        ? `${a.bg} ${a.border} ${a.text}`
                        : 'border-border-subtle text-txt-tertiary hover:text-txt-secondary hover:border-border-mid'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${active ? a.dot : 'bg-border-mid'}`} />
                    {m.label}
                  </button>
                );
              })}
            </div>

            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={e => {
                  setInput(e.target.value);
                  const el = e.target;
                  el.style.height = 'auto';
                  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={realAi ? `Ask in ${activeMode.label} mode…` : 'Configure a provider to start chatting…'}
                className="flex-1 resize-none px-3 py-2 rounded-md bg-surface-canvas border border-border-subtle text-txt-primary text-xs font-mono placeholder:text-txt-tertiary focus:border-brand outline-none transition max-h-28 disabled:opacity-50"
                disabled={streaming || !realAi}
              />
              <button
                onClick={() => send()}
                disabled={streaming || !input.trim() || !realAi}
                className="p-2.5 rounded-md bg-brand text-white hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm shrink-0"
                title="Send"
              >
                {streaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>

            {/* Model chip / configure link */}
            <div className="flex items-center justify-between mt-2">
              <div ref={modelRef} className="relative">
                {modelOptions.length > 0 ? (
                  <>
                    <button
                      onClick={() => setModelOpen(!modelOpen)}
                      className="flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md border border-border-subtle bg-surface-canvas text-txt-secondary hover:border-brand/50 transition font-mono"
                    >
                      <span className="text-txt-tertiary">Model:</span>
                      {workingModel || modelOptions[0]}
                      <ChevronDown className="w-3 h-3 text-txt-tertiary" />
                    </button>
                    {modelOpen && (
                      <div className="absolute left-0 bottom-7 w-52 rounded-md border border-border-mid bg-surface-canvas shadow-xl py-1 z-20 animate-pop max-h-56 overflow-y-auto">
                        {modelOptions.map(m => (
                          <button
                            key={m}
                            onClick={() => {
                              setWorkingModel(m);
                              setModelOpen(false);
                            }}
                            className={`w-full text-left px-3 py-1.5 text-[11px] font-mono transition ${
                              m === workingModel
                                ? 'bg-surface-subtle text-txt-primary font-semibold'
                                : 'text-txt-secondary hover:bg-surface-subtle/60'
                            }`}
                          >
                            {m}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <Link
                    to="/plugins"
                    className="flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-md border border-dashed border-border-mid text-txt-tertiary hover:text-txt-secondary hover:border-brand/50 transition"
                  >
                    <Settings2 className="w-3 h-3" />
                    Add a provider &amp; models →
                  </Link>
                )}
              </div>
              {!realAi && (
                <Link
                  to="/plugins"
                  className="text-[11px] text-txt-tertiary hover:text-txt-secondary underline underline-offset-2 transition"
                >
                  Configure AI provider →
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Collapsed launcher: a quiet prompt that invites the first message. */}
      {!open && (
        <button
          onClick={() => openSession()}
          className="w-full text-left px-4 py-3.5 group"
        >
          <div className="flex items-center gap-2.5">
            <Bot className="w-4 h-4 text-txt-tertiary group-hover:text-brand transition" />
            <span className="text-xs text-txt-tertiary group-hover:text-txt-secondary transition">
              {realAi ? 'Ask, plan, build or debug — the assistant lives here…' : 'Set up an AI provider to unlock the assistant…'}
            </span>
            <span className="ml-auto text-[10px] font-mono uppercase tracking-wider text-txt-tertiary/70">
              open ⏎
            </span>
          </div>
        </button>
      )}
    </div>
  );
};

const HomeMessage: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const isUser = message.role === 'user';
  return (
    <div className={`home-msg flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${
          isUser ? 'bg-brand text-white' : 'bg-surface-subtle border border-border-subtle text-brand'
        }`}
      >
        {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
      </div>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
          isUser
            ? 'bg-brand text-white'
            : 'bg-surface-base border border-border-subtle text-txt-primary markdown-body'
        }`}
      >
        {isUser ? (
          <span className="whitespace-pre-line">{message.content}</span>
        ) : (
          <>
            {message.reasoning && message.reasoning.length > 0 && (
              <div className="mb-2 border-l-2 border-brand/40 pl-2.5 py-0.5">
                {message.reasoning.map(r => (
                  <p key={r.id} className="text-[10px] text-txt-tertiary italic leading-relaxed">
                    {r.text}
                  </p>
                ))}
              </div>
            )}
            <Markdown content={message.content} />
          </>
        )}
      </div>
    </div>
  );
};
