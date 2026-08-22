import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Send,
  Plus,
  Trash2,
  Bot,
  X,
  ChevronsUpDown,
  ChevronDown,
  Download,
  Gauge,
  Loader2,
  PanelLeft,
  RefreshCw,
  Sparkles,
  Square,
  Settings2,
  FolderGit2,
  ArrowUpRight
} from 'lucide-react';
import { getPlugin } from '../../lib/plugins';
import { isRealAi, type AssistantProviderProfile } from '../../lib/assistantProfiles';
import { ASSISTANT_MODES, MODE_ACCENT_CLASSES, getMode, type ModeId } from '../../lib/assistantModes';
import { modelLabel, executeAssistantTool, touchAgentSandbox } from '../../lib/aiApi';
import {
  listConversations,
  createConversation,
  updateConversation,
  deleteConversation,
  runRealTurn,
  applyEvent,
  messageParts,
  uid,
  buildModelContext,
  shouldAutoCompact,
  runCompaction,
  withCompaction,
  type ChatMessage,
  type Conversation,
} from '../../lib/assistantEngine';
import { ChatMessageView } from './ChatMessageView';
import { ComposerAttach } from './ComposerAttach';
import { MobileDrawer } from '../MobileDrawer';
import { appendPastedImages, imageFilesFromClipboard, type ChatImage } from '../../lib/chatImages';

interface RepoOption {
  path: string;
  label?: string;
}

interface ChatSurfaceProps {
  repoPath: string;
  profile: AssistantProviderProfile;
  // Context title shown in the panel header (repo name, PR title, ...).
  title?: string;
  // Shown when this surface is a slide-in panel that can be closed.
  onClose?: () => void;
  // Suggest prompt chips shown on the empty state.
  suggestions?: string[];
  // Attached working context (e.g. the PR diff) injected above history.
  extraContext?: { label: string; text: string } | null;
  // 'panel' (default): embedded in a repo page or slide-in panel.
  // 'workspace': full agentic workspace (/agent) — cross-repo session rail,
  // hero composer, repo switcher.
  variant?: 'panel' | 'workspace';
  // Repo options for the workspace switcher.
  repos?: RepoOption[];
  // Workspace-only: notify the parent page when the user switches repos.
  onRepoChange?: (repoPath: string) => void;
}

const EMPTY_STATE_SUGGESTIONS = [
  'Review this change for regressions',
  'Run the tests and lint',
  'Scan for exposed secrets',
  'Explain what this repo does',
];

export const ChatSurface: React.FC<ChatSurfaceProps> = ({
  repoPath,
  profile,
  title,
  onClose,
  suggestions = EMPTY_STATE_SUGGESTIONS,
  extraContext = null,
  variant = 'panel',
  repos,
  onRepoChange,
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
  const [allConversations, setAllConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<ChatImage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [workingModel, setWorkingModel] = useState(profile.model);
  const [workingReasoning, setWorkingReasoning] = useState(profile.reasoningLevel);
  const [mode, setMode] = useState<ModeId>('ask');
  const [modelOpen, setModelOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const repoMenuRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // When switching repos from a cross-repo session click, carry the target
  // conversation through the reset effect instead of losing it.
  const pendingConvRef = useRef<Conversation | null>(null);

  const current = conversations.find(c => c.id === currentId);

  // Mode sticks to the conversation (or the surface before one exists) so a
  // Plan → Agent handoff survives reloads and panel closes.
  const modeKey = `nixre_mode_${currentId ?? repoPath}`;
  useEffect(() => {
    const saved = localStorage.getItem(modeKey);
    if (saved && ASSISTANT_MODES.some(m => m.id === saved)) setMode(saved as ModeId);
  }, [modeKey]);
  const changeMode = (id: ModeId) => {
    setMode(id);
    try { localStorage.setItem(modeKey, id); } catch {}
  };

  // Rough context-window meter: ~4 chars/token against a nominal budget.
  const contextInfo = useMemo(() => {
    const { summary, history } = buildModelContext(messages);
    const chars = history.reduce((n, t) => n + t.content.length, 0) + (summary?.length ?? 0);
    const tokens = Math.ceil(chars / 4);
    const budget = 16_384; // nominal provider window for the meter
    return {
      pct: Math.min(100, Math.round((tokens / budget) * 100)),
      compactions: messages.filter(m => (m as any).kind === 'compaction').length,
      near: tokens / budget > 0.7,
    };
  }, [messages]);

  const refreshConversations = () => {
    listConversations(repoPath || undefined).then(setConversations).catch(() => {});
    if (variant === 'workspace') {
      listConversations().then(setAllConversations).catch(() => {});
    }
  };

  // Conversations load from the sync backend on mount / repo change.
  useEffect(() => {
    // A cross-repo session click lands here after the parent switches
    // repoPath — restore that conversation instead of resetting.
    const pending = pendingConvRef.current;
    if (pending && pending.repoPath === repoPath) {
      pendingConvRef.current = null;
      setCurrentId(pending.id);
      setMessages(pending.messages ?? []);
      setInput('');
      listConversations(repoPath || undefined).then(setConversations).catch(() => setConversations([]));
      if (variant === 'workspace') listConversations().then(setAllConversations).catch(() => {});
      return;
    }
    pendingConvRef.current = null;
    setConversations([]);
    setCurrentId(null);
    setMessages([]);
    listConversations(repoPath || undefined).then(setConversations).catch(() => setConversations([]));
    if (variant === 'workspace') listConversations().then(setAllConversations).catch(() => setAllConversations([]));
  }, [repoPath, variant]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
      if (reasoningRef.current && !reasoningRef.current.contains(e.target as Node)) setReasoningOpen(false);
      if (repoMenuRef.current && !repoMenuRef.current.contains(e.target as Node)) setRepoOpen(false);
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
    setPendingImages([]);
  };

  const loadConversation = (conv: Conversation) => {
    setCurrentId(conv.id);
    setMessages(conv.messages);
    setInput('');
  };

  /** Open a session from the workspace rail — switching repos if needed. */
  const openConversation = (conv: Conversation) => {
    if (conv.repoPath === repoPath) {
      loadConversation(conv);
      return;
    }
    pendingConvRef.current = conv;
    onRepoChange?.(conv.repoPath);
  };

  /** Core turn runner — `base` is the transcript the turn appends to. */
  const runTurn = async (prompt: string, base: ChatMessage[], images: ChatImage[] = []) => {
    if (!realAi) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    let convId = currentId;
    let turnTitle = current?.title ?? prompt.slice(0, 48);
    try {
      if (!convId) {
        const conv = await createConversation(repoPath, prompt.slice(0, 48));
        convId = conv.id;
        turnTitle = conv.title;
        setCurrentId(conv.id);
        refreshConversations();
      }

      const userMessage: ChatMessage = {
        id: uid('u'),
        role: 'user',
        content: prompt,
        images: images.length ? images : undefined,
        createdAt: Date.now(),
      };
      // Accumulate locally: state from the closure would go stale across
      // awaits inside the streaming loop below.
      let local: ChatMessage[] = [...base, userMessage];
      setMessages(local);
      await updateConversation({ id: convId, repoPath, title: turnTitle, messages: local, updatedAt: Date.now() });

      const workingProfile: AssistantProviderProfile = {
        ...profile,
        model: workingModel,
        reasoningLevel: workingReasoning,
      };

      // @-mentions: files referenced as @path/to/file are fetched via the
      // tools endpoint and attached as context (up to 3).
      let modelPrompt = prompt;
      const mentions = [...prompt.matchAll(/(?:^|\s)@([\w./-]+)/g)].map(m => m[1]).slice(0, 3);
      if (mentions.length > 0) {
        const snippets: string[] = [];
        for (const p of mentions) {
          try {
            const content = await executeAssistantTool(repoPath, 'read_file', { path: p });
            snippets.push(`--- ${p} ---\n${content}`);
          } catch {
            snippets.push(`--- ${p} --- (could not read: not found or unreadable)`);
          }
        }
        modelPrompt = `<referenced_files>\n${snippets.join('\n\n')}\n</referenced_files>\n\n${prompt}`;
      }

      // History comes from the pre-turn transcript; auto-compaction replaces
      // everything before the last compaction entry with its summary.
      const { summary, history } = buildModelContext(base);
      const agentMode = mode === 'agent' || mode === 'debug';
      if (agentMode && convId) {
        void touchAgentSandbox(repoPath, convId);
      }
      try {
        for await (const ev of runRealTurn(modelPrompt, workingProfile, history, {
          model: workingModel,
          reasoningLevel: workingReasoning,
          mode,
          compactionSummary: summary ?? undefined,
          repoPath,
          conversationId: convId ?? undefined,
          agent: agentMode,
          signal: controller.signal,
          extraContext: extraContext ? `${extraContext.label}\n\n${extraContext.text}` : undefined,
          images: images.length ? images : undefined,
        })) {
          local = applyEvent(local, ev);
          setMessages(local);
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          local = applyEvent(local, {
            type: 'message_text',
            text: `\n\n> ⚠️ ${err.message || 'The AI provider request failed.'}`,
          });
          setMessages(local);
        }
      }
      await updateConversation({ id: convId, repoPath, title: turnTitle, messages: local, updatedAt: Date.now() });

      // Auto-compaction: once enough turns pile up, have the model distill
      // them into a handoff summary so later turns stay inside the context
      // window without losing the thread.
      if (shouldAutoCompact(local)) {
        try {
          const compactSummary = await runCompaction(local, workingProfile, { model: workingModel });
          local = withCompaction(local, compactSummary);
          setMessages(local);
          await updateConversation({ id: convId, repoPath, title: turnTitle, messages: local, updatedAt: Date.now() });
        } catch {
          // Compaction is best-effort — never fail a turn over it.
        }
      }
    } catch {
      // Backend unreachable — the turn still rendered locally; surface nothing
      // extra here, the sidebar refresh below will reflect the true state.
    } finally {
      abortRef.current = null;
      setStreaming(false);
      refreshConversations();
    }
  };

  const send = (text?: string) => {
    const prompt = (text ?? input).trim();
    if ((!prompt && pendingImages.length === 0) || streaming || !realAi) return;
    const images = pendingImages;
    setInput('');
    setPendingImages([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    void runTurn(prompt || '(image)', messages, images);
  };

  const stop = () => abortRef.current?.abort();

  /** Drop everything after the last user message and run it again. */
  const regenerate = () => {
    if (streaming) return;
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { idx = i; break; }
    }
    if (idx === -1) return;
    const prompt = messages[idx].content;
    const base = messages.slice(0, idx);
    setMessages(base);
    void runTurn(prompt, base);
  };

  /** Edit a sent user message: truncate the transcript there and resend. */
  const editMessage = (id: string, newText: string) => {
    if (streaming || !newText.trim()) return;
    const idx = messages.findIndex(m => m.id === id);
    if (idx === -1 || messages[idx].role !== 'user') return;
    setEditingId(null);
    const base = messages.slice(0, idx);
    setMessages(base);
    void runTurn(newText.trim(), base);
  };

  /** Download the transcript as Markdown (reasoning folded into details). */
  const exportMarkdown = () => {
    const lines: string[] = [`# ${title || repoPath} — assistant transcript`, ''];
    for (const m of messages) {
      if ((m as any).kind === 'compaction') {
        lines.push('> 🗜️ _Context compacted — earlier messages summarized_', '');
        continue;
      }
      if (m.role === 'user') {
        lines.push(`**You:**\n\n${m.content}`, '');
      } else {
        for (const part of messageParts(m)) {
          if (part.type === 'reasoning') {
            lines.push('<details><summary>Thought process</summary>', '', part.text, '', '</details>', '');
          } else if (part.type === 'tool') {
            const t = part.tool;
            lines.push(`\`${t.name}\`${t.argsText && t.argsText !== '{}' ? ` ${t.argsText}` : ''}`);
            if (t.output) lines.push('```', t.output, '```');
            lines.push('');
          } else if (part.type === 'text' && part.text) {
            lines.push(`**Assistant:**\n\n${part.text}`, '');
          }
        }
        if (!messageParts(m).some(p => p.type === 'text' || p.type === 'tool')) {
          lines.push(`**Assistant:**\n\n_(stopped before answering)_`, '');
        }
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(title || repoPath).replace(/[^\w.-]+/g, '-')}-chat.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Global shortcuts: ⌘/Ctrl+K focuses the composer, Esc stops a turn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        textareaRef.current?.focus();
      } else if (e.key === 'Escape' && streaming) {
        stop();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [streaming]);

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

  const workspace = variant === 'workspace';
  const heroMode = workspace && realAi && messages.length === 0;

  const effortBadge = (r: string) =>
    r === 'none' ? '—' : r.charAt(0).toUpperCase() + r.slice(1);

  // Workspace session rail: every conversation across every repo, grouped
  // by repo — the Cursor-style agent task list.
  const groupedSessions = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const c of [...allConversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const list = map.get(c.repoPath) ?? [];
      list.push(c);
      map.set(c.repoPath, list);
    }
    return [...map.entries()];
  }, [allConversations]);

  const repoAssistantUrl = /^[\w.-]+\/[\w.-]+$/.test(repoPath)
    ? `/${repoPath}/assistant`
    : null;

  const panelSessionList = (
    <>
      <div className="p-3 border-b border-border-subtle flex items-center justify-between">
        <span className="text-xs font-semibold text-txt-primary uppercase tracking-wider flex items-center gap-1.5">
          <Bot className="w-4 h-4 text-brand" />
          Chats
        </span>
        <button
          type="button"
          onClick={() => {
            setSessionDrawerOpen(false);
            startNewChat();
          }}
          title="New chat"
          className="min-h-11 min-w-11 flex items-center justify-center rounded hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition"
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
              className={`group flex items-center justify-between rounded px-2 py-2.5 text-xs cursor-pointer transition min-h-11 ${
                c.id === currentId
                  ? 'bg-surface-subtle text-txt-primary'
                  : 'text-txt-secondary hover:bg-surface-subtle/60 active:bg-surface-subtle'
              }`}
              onClick={() => {
                setSessionDrawerOpen(false);
                loadConversation(c);
              }}
            >
              <span className="truncate pr-1 flex-1">{c.title || 'Untitled'}</span>
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  deleteConversation(c.id)
                    .then(() => {
                      if (currentId === c.id) startNewChat();
                    })
                    .catch(() => {})
                    .finally(refreshConversations);
                }}
                className="flex sm:opacity-0 sm:group-hover:opacity-100 min-h-11 min-w-11 items-center justify-center rounded hover:bg-feedback-error-bg text-txt-tertiary hover:text-feedback-error-text transition shrink-0"
                title="Delete"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );

  const workspaceRail = (
    <aside className="hidden sm:flex flex-col w-64 shrink-0 min-h-0 border-r border-border-subtle bg-surface-canvas">
      <div className="flex items-center justify-between p-3 border-b border-border-subtle">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-txt-primary uppercase tracking-wider">
          <Sparkles className="w-4 h-4 text-brand" />
          Agent Tasks
        </span>
        <button
          onClick={startNewChat}
          title="New task"
          className="p-1.5 rounded hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {groupedSessions.length === 0 ? (
          <p className="text-[11px] text-txt-tertiary px-3 py-2">
            No sessions yet — describe an engineering task to begin.
          </p>
        ) : (
          groupedSessions.map(([groupPath, convs]) => (
            <div key={groupPath} className="mb-1">
              <p className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-txt-tertiary truncate">
                <FolderGit2 className="w-3 h-3 shrink-0" />
                {groupPath}
              </p>
              {convs.map(c => (
                <div
                  key={c.id}
                  className={`group flex items-center justify-between rounded mx-1 px-2 py-1.5 text-xs cursor-pointer transition ${
                    c.id === currentId
                      ? 'bg-surface-subtle text-txt-primary'
                      : 'text-txt-secondary hover:bg-surface-subtle/60'
                  }`}
                  onClick={() => openConversation(c)}
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
                    className="flex sm:opacity-0 sm:group-hover:opacity-100 min-h-11 min-w-11 items-center justify-center rounded hover:bg-feedback-error-bg text-txt-tertiary hover:text-feedback-error-text transition shrink-0"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
      {repoAssistantUrl && (
        <div className="border-t border-border-subtle p-2">
          <Link
            to={repoAssistantUrl}
            title="Open this repo's scoped assistant"
            className="flex items-center justify-center gap-1.5 text-[11px] px-2 py-2.5 rounded-md text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition min-h-11"
          >
            <FolderGit2 className="w-3.5 h-3.5" />
            Repo assistant
          </Link>
        </div>
      )}
    </aside>
  );

  // Repo switcher — only rendered when the parent supplies options (/agent).
  const repoSwitcher = repos && repos.length > 0 && (
    <div ref={repoMenuRef} className="relative">
      <button
        onClick={() => { setRepoOpen(!repoOpen); setModelOpen(false); setReasoningOpen(false); }}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border-subtle bg-surface-base text-txt-primary hover:border-brand transition max-w-52"
      >
        <FolderGit2 className="w-3.5 h-3.5 text-txt-tertiary shrink-0" />
        <span className="truncate font-mono">{repoPath || 'pick a repo'}</span>
        <ChevronDown className="w-3.5 h-3.5 text-txt-tertiary shrink-0" />
      </button>
      {repoOpen && (
        <div className="absolute left-0 bottom-8 w-[min(16rem,calc(100vw-2rem))] max-h-64 overflow-y-auto rounded-md border border-border-mid bg-surface-canvas shadow-xl py-1 z-30 animate-pop">
          {repos.map(r => (
            <button
              key={r.path}
              onClick={() => { setRepoOpen(false); if (r.path !== repoPath) onRepoChange?.(r.path); }}
              className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate transition ${
                r.path === repoPath ? 'bg-surface-subtle text-txt-primary font-semibold' : 'text-txt-secondary hover:bg-surface-subtle/60'
              }`}
            >
              {r.path}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const modePills = (
    <div className="flex items-center gap-1.5 max-w-3xl mx-auto mb-2 flex-wrap">
      {ASSISTANT_MODES.map(m => {
        const active = m.id === mode;
        const accent = MODE_ACCENT_CLASSES[m.accent];
        return (
          <button
            key={m.id}
            onClick={() => changeMode(m.id)}
            title={m.description}
            className={`flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full border transition ${
              active
                ? `${accent.bg} ${accent.border} ${accent.text}`
                : 'border-border-subtle text-txt-tertiary hover:text-txt-secondary hover:border-border-mid'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${active ? accent.dot : 'bg-border-mid'}`} />
            {m.label}
          </button>
        );
      })}
    </div>
  );

  // Composer control row — repo switcher + Cursor-style model card (models
  // carry their effort badge; reasoning effort lives in the card footer).
  const controlRow = (
    <div className="flex items-center gap-2 max-w-3xl mx-auto mb-2 flex-wrap">
      {repoSwitcher}

      <div ref={modelRef} className="relative">
        {modelOptions.length > 0 ? (
          <button
            onClick={() => { setModelOpen(!modelOpen); setReasoningOpen(false); }}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border border-border-subtle bg-surface-base text-txt-primary hover:border-brand transition"
          >
            <Sparkles className="w-3.5 h-3.5 text-brand" />
            <span className="font-mono">{modelLabel(activeModelLabel)}</span>
            <span className="text-[9px] uppercase tracking-wider text-txt-tertiary border border-border-subtle rounded px-1 py-px">
              {effortBadge(workingReasoning)}
            </span>
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
            <span className="italic">no provider configured</span>
          </Link>
        )}
        {modelOpen && modelOptions.length > 0 && (
          <div className="absolute left-0 bottom-8 w-[min(20rem,calc(100vw-2rem))] rounded-md border border-border-mid bg-surface-canvas shadow-xl z-30 animate-pop">
            <p className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-txt-tertiary border-b border-border-subtle">
              Model · {getMode(mode).label} mode
            </p>
            <div className="max-h-56 overflow-y-auto py-1">
              {modelOptions.map(m => (
                <button
                  key={m}
                  onClick={() => { setWorkingModel(m); setModelOpen(false); }}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs transition ${
                    m === workingModel ? 'bg-surface-subtle' : 'hover:bg-surface-subtle/60'
                  }`}
                >
                  <span className={`truncate font-mono ${m === workingModel ? 'text-txt-primary font-semibold' : 'text-txt-secondary'}`}>
                    {modelLabel(m)}
                  </span>
                  <span className={`shrink-0 text-[9px] uppercase tracking-wider rounded border px-1 py-px ${
                    workingReasoning === 'none'
                      ? 'border-border-subtle text-txt-tertiary'
                      : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-400'
                  }`}>
                    {effortBadge(workingReasoning)}
                  </span>
                </button>
              ))}
            </div>
            <div className="border-t border-border-subtle px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-txt-tertiary mb-1.5">Reasoning effort</p>
              <div className="grid grid-cols-4 gap-1">
                {reasoningOptions.map(r => (
                  <button
                    key={r}
                    onClick={() => setWorkingReasoning(r)}
                    title={r === 'none' ? 'No visible thinking tokens' : `Request ${r}-effort thinking`}
                    className={`text-[10px] capitalize py-1 rounded border transition ${
                      r === workingReasoning
                        ? 'border-brand bg-brand/10 text-brand font-semibold'
                        : 'border-border-subtle text-txt-tertiary hover:text-txt-secondary hover:border-border-mid'
                    }`}
                  >
                    {r === 'none' ? 'off' : r}
                  </button>
                ))}
              </div>
            </div>
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

      {/* Regenerate: rerun the last user prompt (disabled mid-stream). */}
      {messages.some(m => m.role === 'user') && (
        <button
          onClick={regenerate}
          disabled={streaming}
          title="Regenerate the last reply"
          className="text-xs px-2.5 py-1 rounded-md text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Retry</span>
        </button>
      )}

      {messages.length > 0 && (
        <button
          onClick={exportMarkdown}
          title="Export transcript as Markdown"
          className="text-xs px-2.5 py-1 rounded-md text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
        >
          <Download className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Context meter — rough token estimate + compaction count. */}
      {messages.length > 0 && (
        <span
          title={`Roughly ${contextInfo.pct}% of a ~16k-token context used${
            contextInfo.compactions > 0 ? ` · auto-compacted ×${contextInfo.compactions}` : ''
          }`}
          className={`ml-auto flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border ${
            contextInfo.near
              ? 'border-amber-400/30 bg-amber-400/10 text-amber-400'
              : 'border-border-subtle text-txt-tertiary'
          }`}
        >
          <Gauge className="w-3 h-3" />
          ctx {contextInfo.pct}%
          {contextInfo.compactions > 0 && ` · 🗜️×${contextInfo.compactions}`}
        </span>
      )}
    </div>
  );

  const onPasteImages = async (e: React.ClipboardEvent) => {
    const files = imageFilesFromClipboard(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    const { next } = await appendPastedImages(pendingImages, files);
    setPendingImages(next);
  };

  const composerRow = (
    <div className="flex-1 min-w-0">
      <ComposerAttach images={pendingImages} onRemove={id => setPendingImages(imgs => imgs.filter(i => i.id !== id))} />
      <div className="flex items-end gap-2 max-w-3xl mx-auto">
      <textarea
        ref={textareaRef}
        rows={1}
        value={input}
        onChange={e => {
          setInput(e.target.value);
          const el = e.target;
          el.style.height = 'auto';
          el.style.height = Math.min(el.scrollHeight, 200) + 'px';
        }}
        onKeyDown={handleKeyDown}
        onPaste={onPasteImages}
        placeholder={
          realAi
            ? mode === 'agent'
              ? 'Plan, build, fix — the agent can read, search and run commands in this repo (@file to attach)…'
              : 'Ask the assistant anything… (@file to attach)'
            : 'Configure a provider to start chatting…'
        }
        className={`flex-1 resize-none px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary font-mono placeholder:text-txt-tertiary focus:border-brand outline-none transition disabled:opacity-50 ${
          heroMode ? 'min-h-[96px] text-sm' : 'max-h-40 text-xs'
        }`}
        disabled={streaming || !realAi}
      />
      {streaming ? (
        <button
          onClick={stop}
          className="p-2.5 rounded-md bg-feedback-error-bg text-feedback-error-text hover:bg-feedback-error-bg/70 border border-feedback-error-text/30 transition shrink-0"
          title="Stop (Esc)"
        >
          <Square className="w-4 h-4" />
        </button>
      ) : (
        <button
          onClick={() => send()}
          disabled={(!input.trim() && pendingImages.length === 0) || !realAi}
          className="p-2.5 rounded-md bg-brand text-white hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm shrink-0"
          title="Send"
        >
          <Send className="w-4 h-4" />
        </button>
      )}
      </div>
    </div>
  );

  const composerBlock = (
    <>
      {modePills}
      {controlRow}
      {composerRow}
      <p className="max-w-3xl mx-auto mt-1.5 text-[10px] font-mono text-txt-tertiary">
        @file attaches code · Enter sends · Shift+Enter newline
        {workspace ? ' · tools run per repo permissions' : ''}
      </p>
    </>
  );

  return (
    <div className="flex h-full min-h-0 bg-surface-base">
      {!workspace && (
        <MobileDrawer
          open={sessionDrawerOpen}
          onClose={() => setSessionDrawerOpen(false)}
          title="Chats"
        >
          <div className="flex flex-col min-h-full">{panelSessionList}</div>
        </MobileDrawer>
      )}

      {/* Session rail — workspace variant groups every repo's sessions */}
      {workspace ? (
        workspaceRail
      ) : (
      <aside className="hidden sm:flex flex-col w-60 shrink-0 min-h-0 border-r border-border-subtle bg-surface-canvas">
        {panelSessionList}
      </aside>
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-3 sm:px-4 py-3 border-b border-border-subtle bg-surface-canvas">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {!workspace && (
              <button
                type="button"
                onClick={() => setSessionDrawerOpen(true)}
                className="sm:hidden shrink-0 min-h-11 min-w-11 flex items-center justify-center rounded-md text-txt-secondary hover:bg-surface-subtle transition"
                title="Chats"
                aria-label="Open chat list"
              >
                <PanelLeft className="w-5 h-5" />
              </button>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-txt-primary truncate">
                <Sparkles className="w-4 h-4 text-brand shrink-0 hidden sm:block" />
                <span className="truncate">{current?.title || title || repoPath}</span>
              </div>
              <p className="text-[11px] text-txt-tertiary truncate">
                Nixre Assistant • {profile.provider}
                {realAi ? <span className={MODE_ACCENT_CLASSES[getMode(mode).accent].text}> • {getMode(mode).label}</span> : <span> • not configured</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
          {workspace && repoAssistantUrl && (
            <Link
              to={repoAssistantUrl}
              title="Open this repo's scoped assistant panel"
              className="hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-border-subtle text-txt-secondary hover:text-txt-primary hover:border-brand transition min-h-11"
            >
              Repo view
              <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="min-h-11 min-w-11 flex items-center justify-center rounded hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            realAi && heroMode ? (
              <div className="h-full flex flex-col items-center justify-center px-6 pb-10">
                <div className="w-full max-w-2xl mx-auto">
                  <div className="mx-auto w-11 h-11 rounded-xl bg-surface-subtle border border-border-subtle flex items-center justify-center mb-4">
                    <Bot className="w-5 h-5 text-brand" />
                  </div>
                  <h2 className="text-lg font-semibold text-txt-primary mb-1 text-center">What are we engineering?</h2>
                  <p className="text-xs text-txt-secondary text-center max-w-md mx-auto mb-6">
                    Give the agent a goal — it plans, reads code and runs commands inside{' '}
                    <span className="font-mono text-txt-primary">{repoPath || 'a repo you pick'}</span>. Switch to Ask for quick questions.
                  </p>
                  {composerBlock}
                </div>
              </div>
            ) : realAi ? (
              <div className="h-full flex flex-col items-center justify-center px-6 text-center">
                <div className="w-12 h-12 rounded-xl bg-surface-subtle border border-border-subtle flex items-center justify-center mb-4">
                  <Bot className="w-6 h-6 text-brand" />
                </div>
                <h2 className="text-base font-semibold text-txt-primary mb-1">How can I help in {repoPath}?</h2>
                <p className="text-xs text-txt-secondary max-w-md mb-6">
                  Pick a mode below and ask anything — answers come straight from your configured provider.
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
              <div className="h-full flex flex-col items-center justify-center px-6 text-center">
                <div className="w-12 h-12 rounded-xl bg-surface-subtle border border-border-subtle flex items-center justify-center mb-4">
                  <Settings2 className="w-6 h-6 text-txt-tertiary" />
                </div>
                <h2 className="text-base font-semibold text-txt-primary mb-1">No AI provider configured</h2>
                <p className="text-xs text-txt-secondary max-w-md mb-5">
                  The assistant needs a validated provider (DeepSeek, OpenAI, Anthropic, Ollama or any
                  OpenAI-compatible endpoint) before it can answer. Keys are stored encrypted server-side.
                </p>
                <Link
                  to="/plugins"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand-hover transition shadow-sm"
                >
                  <Settings2 className="w-4 h-4" />
                  Configure a provider
                </Link>
              </div>
            )
          ) : (
            <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
              {messages.map((msg, i) =>
                (msg as any).kind === 'compaction' ? (
                  <CompactionDivider key={msg.id} summary={(msg as any).summary as string} />
                ) : (
                  <ChatMessageView
                    key={msg.id}
                    message={msg}
                    streaming={streaming && i === messages.length - 1 && msg.role === 'assistant'}
                    onEdit={msg.role === 'user' && !streaming ? editMessage : undefined}
                  />
                ),
              )}
            </div>
          )}
        </div>

        {/* Input — hidden on the workspace hero, where the composer lives center-stage */}
        {!heroMode && (
          <div className="border-t border-border-subtle bg-surface-canvas p-3">
            {composerBlock}
          </div>
        )}
      </div>
    </div>
  );
};

/** Marker between compacted history and live messages — expandable to inspect the handoff summary. */
const CompactionDivider: React.FC<{ summary: string }> = ({ summary }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-center gap-1 py-1">
      <button
        onClick={() => setOpen(o => !o)}
        title={open ? 'Hide compaction summary' : 'Show what the assistant remembers from earlier'}
        className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-txt-tertiary hover:text-txt-secondary transition"
      >
        <ChevronsUpDown className="w-3 h-3" />
        Context compacted — earlier messages summarized
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronDown className="w-3 h-3 -rotate-90" />}
      </button>
      {open && (
        <div className="max-w-xl border border-border-subtle bg-surface-base rounded-md px-3 py-2 text-[11px] text-txt-secondary whitespace-pre-line leading-relaxed">
          {summary}
        </div>
      )}
    </div>
  );
};

