// Agentic engineering workspace — Cursor-inspired void + floating composer.
//
// Deliberately not a chat panel. Empty state is a near-black canvas with one
// centered input card. Active sessions keep the same floating composer docked
// at the bottom and a quiet left rail of past tasks grouped by repo.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowUp,
  Bot,
  ChevronDown,
  Download,
  FolderGit2,
  Loader2,
  Plus,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import { isPluginLive } from '../lib/pluginPreferences';
import {
  getActiveProviderProfile,
  isRealAi,
  type AssistantProviderProfile,
} from '../lib/assistantProfiles';
import { ASSISTANT_MODES, getMode, type ModeId } from '../lib/assistantModes';
import { modelLabel, executeAssistantTool } from '../lib/aiApi';
import {
  listConversations,
  createConversation,
  updateConversation,
  deleteConversation,
  runRealTurn,
  applyEvent,
  uid,
  buildModelContext,
  shouldAutoCompact,
  runCompaction,
  withCompaction,
  type ChatMessage,
  type Conversation,
} from '../lib/assistantEngine';
import { ChatMessageView } from '../components/assistant/ChatMessageView';
import { ComposerAttach } from '../components/assistant/ComposerAttach';
import { appendPastedImages, imageFilesFromClipboard, type ChatImage } from '../lib/chatImages';
import {
  downloadJsonl,
  estimateTokens,
  lastTurnMetrics,
  stamp,
  tokensPerSecond,
  type SessionTraceDraft,
  type SessionTraceEntry,
  type TokenUsage,
} from '../lib/sessionTrace';

interface WorkspaceRepo {
  path: string;
  label: string;
}

const QUICK_CHIPS = [
  { label: 'Plan a feature', prompt: 'Research this repo and produce a concrete plan for the next feature I should ship.' },
  { label: 'Fix failing tests', prompt: 'Find failing tests, diagnose the root cause, and fix them.' },
  { label: 'Review for bugs', prompt: 'Audit the recent changes for bugs, dead code and security issues.' },
  { label: 'Explain the architecture', prompt: 'Map the architecture of this repo — entry points, key modules, data flow.' },
];

function relativeAge(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

function effortBadge(r: string): string {
  if (r === 'none') return '—';
  return r.charAt(0).toUpperCase() + r.slice(1);
}

export const AgentWorkspace: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const repoParam = searchParams.get('repo') ?? '';

  const [profile, setProfile] = useState<AssistantProviderProfile | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [repos, setRepos] = useState<WorkspaceRepo[]>([]);
  const [loading, setLoading] = useState(true);

  const [allConversations, setAllConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<ChatImage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState<ModeId>('agent');
  const [workingModel, setWorkingModel] = useState('');
  const [workingReasoning, setWorkingReasoning] = useState('medium');
  const [modelOpen, setModelOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [trace, setTrace] = useState<SessionTraceEntry[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const repoMenuRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const traceRef = useRef<SessionTraceEntry[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const currentIdRef = useRef<string | null>(null);

  // --- boot ----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      isPluginLive('nixre-assistant'),
      getActiveProviderProfile(),
      api.listRepos().catch(() => []),
    ])
      .then(([isLive, activeProfile, repoList]) => {
        if (cancelled) return;
        setLive(isLive);
        setProfile(activeProfile);
        setWorkingModel(activeProfile.model || activeProfile.models[0] || '');
        setWorkingReasoning(activeProfile.reasoningLevel || 'medium');
        setRepos(
          repoList.map(r => ({
            path: r.path,
            label: r.path.split('/').pop() || r.path,
          })),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeRepo =
    repos.find(r => r.path === repoParam)?.path ?? repos[0]?.path ?? '';

  const changeRepo = useCallback(
    (path: string) => {
      setSearchParams(path ? { repo: path } : {});
      setCurrentId(null);
      currentIdRef.current = null;
      setMessages([]);
      setTrace([]);
      traceRef.current = [];
      setInput('');
    },
    [setSearchParams],
  );

  // Keep mode sticky per repo/session.
  const modeKey = `nixre_mode_${currentId ?? (activeRepo || 'agent')}`;
  useEffect(() => {
    const saved = localStorage.getItem(modeKey);
    if (saved && ASSISTANT_MODES.some(m => m.id === saved)) setMode(saved as ModeId);
    else setMode('agent');
  }, [modeKey]);
  const changeMode = (id: ModeId) => {
    setMode(id);
    try {
      localStorage.setItem(modeKey, id);
    } catch {
      /* ignore */
    }
    setModeOpen(false);
    if (id !== mode && currentIdRef.current) {
      logTrace({
        type: 'system_prompt_change',
        mode: id,
        systemPrompt: getMode(id).systemPrompt,
      });
    }
  };

  useEffect(() => {
    traceRef.current = trace;
  }, [trace]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);

  const persistTrace = (
    next: SessionTraceEntry[],
    msgs = messagesRef.current,
    title?: string,
  ) => {
    traceRef.current = next;
    setTrace(next);
    const id = currentIdRef.current;
    if (!id || !activeRepo) return;
    const resolvedTitle =
      title ?? allConversations.find(c => c.id === id)?.title ?? 'Agent';
    void updateConversation({
      id,
      repoPath: activeRepo,
      title: resolvedTitle,
      messages: msgs,
      updatedAt: Date.now(),
      trace: next,
    }).catch(() => {});
  };

  const logTrace = (entry: SessionTraceDraft) => {
    persistTrace([...traceRef.current, stamp(entry)]);
  };

  const seedSessionTrace = (
    convId: string,
    repoPath: string,
    msgs: ChatMessage[],
    title: string,
  ) => {
    if (traceRef.current.some(e => e.type === 'session')) return;
    const header = stamp({
      type: 'session',
      repoPath,
      provider: profile?.provider || 'unknown',
      modelId: workingModel || profile?.model || '',
      thinkingLevel: workingReasoning,
      mode,
      systemPrompt: getMode(mode).systemPrompt,
    });
    const next = [header, ...traceRef.current];
    currentIdRef.current = convId;
    persistTrace(next, msgs, title);
  };

  const changeModel = (modelId: string) => {
    if (modelId === workingModel) {
      setModelOpen(false);
      return;
    }
    setWorkingModel(modelId);
    setModelOpen(false);
    if (currentIdRef.current) {
      logTrace({
        type: 'model_change',
        provider: profile?.provider || 'unknown',
        modelId,
      });
    }
  };

  const changeReasoning = (level: string) => {
    if (level === workingReasoning) return;
    setWorkingReasoning(level);
    if (currentIdRef.current) {
      logTrace({ type: 'thinking_level_change', thinkingLevel: level });
    }
  };

  const refreshSessions = useCallback(() => {
    listConversations()
      .then(setAllConversations)
      .catch(() => setAllConversations([]));
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Scroll transcript to bottom on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Close floating menus on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (modelRef.current && !modelRef.current.contains(t)) setModelOpen(false);
      if (repoMenuRef.current && !repoMenuRef.current.contains(t)) setRepoOpen(false);
      if (modeMenuRef.current && !modeMenuRef.current.contains(t)) setModeOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Esc stops a running turn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && streaming) abortRef.current?.abort();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [streaming]);

  const groupedSessions = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const c of [...allConversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const list = map.get(c.repoPath) ?? [];
      list.push(c);
      map.set(c.repoPath, list);
    }
    return [...map.entries()];
  }, [allConversations]);

  const realAi = profile ? isRealAi(profile) : false;
  const modelOptions = profile?.models ?? [];
  const activeModelLabel = modelOptions.includes(workingModel)
    ? workingModel
    : modelOptions[0] ?? workingModel;
  const empty = messages.length === 0 && !currentId;

  // --- turn loop -----------------------------------------------------------
  const runTurn = async (prompt: string, base: ChatMessage[], images: ChatImage[] = []) => {
    if (!realAi || !profile || !activeRepo) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    let convId = currentId;
    let turnTitle =
      allConversations.find(c => c.id === currentId)?.title ?? prompt.slice(0, 48);
    try {
      if (!convId) {
        const conv = await createConversation(activeRepo, prompt.slice(0, 48));
        convId = conv.id;
        turnTitle = conv.title;
        currentIdRef.current = conv.id;
        setCurrentId(conv.id);
        refreshSessions();
      }

      const userMessage: ChatMessage = {
        id: uid('u'),
        role: 'user',
        content: prompt,
        images: images.length ? images : undefined,
        createdAt: Date.now(),
      };
      let local: ChatMessage[] = [...base, userMessage];
      setMessages(local);
      await updateConversation({
        id: convId,
        repoPath: activeRepo,
        title: turnTitle,
        messages: local,
        updatedAt: Date.now(),
        trace: traceRef.current,
      });
      seedSessionTrace(convId, activeRepo, local, turnTitle);

      const workingProfile: AssistantProviderProfile = {
        ...profile,
        model: workingModel || profile.model,
        reasoningLevel: workingReasoning,
      };

      // @file mentions attach source as context.
      let modelPrompt = prompt;
      const mentions = [...prompt.matchAll(/(?:^|\s)@([\w./-]+)/g)].map(m => m[1]).slice(0, 3);
      if (mentions.length > 0) {
        const snippets: string[] = [];
        for (const p of mentions) {
          try {
            const content = await executeAssistantTool(activeRepo, 'read_file', { path: p });
            snippets.push(`--- ${p} ---\n${content}`);
          } catch {
            snippets.push(`--- ${p} --- (could not read)`);
          }
        }
        modelPrompt = `<referenced_files>\n${snippets.join('\n\n')}\n</referenced_files>\n\n${prompt}`;
      }

      const { summary, history } = buildModelContext(base);
      const startedAt = performance.now();
      let outputChars = 0;
      let reasoningChars = 0;
      let usage: TokenUsage | undefined;
      try {
        for await (const ev of runRealTurn(modelPrompt, workingProfile, history, {
          model: workingModel || profile.model,
          reasoningLevel: workingReasoning,
          mode,
          compactionSummary: summary ?? undefined,
          repoPath: activeRepo,
          agent: mode === 'agent' || mode === 'debug',
          signal: controller.signal,
          images: images.length ? images : undefined,
        })) {
          if (ev.type === 'message_text') outputChars += ev.text.length;
          if (ev.type === 'reasoning') reasoningChars += ev.text.length;
          if (ev.type === 'usage') usage = ev.usage;
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
      const elapsedMs = Math.round(performance.now() - startedAt);
      const estimatedTokens = usage?.output ?? estimateTokens(outputChars + reasoningChars);
      const extras: SessionTraceEntry[] = [];
      if (reasoningChars > 0) {
        extras.push(
          stamp({
            type: 'reasoning_used',
            thinkingLevel: workingReasoning,
            chars: reasoningChars,
            estimatedTokens: estimateTokens(reasoningChars),
          }),
        );
      }
      extras.push(
        stamp({
          type: 'turn_metrics',
          modelId: workingModel || profile.model,
          provider: profile.provider,
          thinkingLevel: workingReasoning,
          mode,
          elapsedMs,
          outputChars,
          reasoningChars,
          estimatedTokens,
          tokensPerSecond: tokensPerSecond(estimatedTokens, elapsedMs),
          ...(usage ? { usage } : {}),
        }),
      );
      const nextTrace = [...traceRef.current, ...extras];
      traceRef.current = nextTrace;
      setTrace(nextTrace);

      await updateConversation({
        id: convId,
        repoPath: activeRepo,
        title: turnTitle,
        messages: local,
        updatedAt: Date.now(),
        trace: nextTrace,
      });

      if (shouldAutoCompact(local)) {
        try {
          const compactSummary = await runCompaction(local, workingProfile, {
            model: workingModel || profile.model,
          });
          local = withCompaction(local, compactSummary);
          setMessages(local);
          await updateConversation({
            id: convId,
            repoPath: activeRepo,
            title: turnTitle,
            messages: local,
            updatedAt: Date.now(),
            trace: nextTrace,
          });
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* backend unreachable — local state still rendered */
    } finally {
      abortRef.current = null;
      setStreaming(false);
      refreshSessions();
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

  const startNew = () => {
    setCurrentId(null);
    setMessages([]);
    setInput('');
    setPendingImages([]);
    setTrace([]);
    traceRef.current = [];
    currentIdRef.current = null;
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const openConversation = (c: Conversation) => {
    if (c.repoPath !== activeRepo) {
      setSearchParams(c.repoPath ? { repo: c.repoPath } : {});
    }
    setCurrentId(c.id);
    currentIdRef.current = c.id;
    setMessages(c.messages ?? []);
    setTrace(c.trace ?? []);
    traceRef.current = c.trace ?? [];
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // --- gate states ---------------------------------------------------------
  if (loading) {
    return (
      <div className="agent-shell flex items-center justify-center text-xs text-txt-tertiary font-mono">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Opening workspace…
      </div>
    );
  }

  if (!live) {
    return (
      <div className="agent-shell flex items-center justify-center px-6">
        <GateCard
          title="Nixre Assistant is off"
          body="Enable the assistant plugin to use the agentic engineering workspace."
          action={{ to: '/plugins', label: 'Open Plugins' }}
        />
      </div>
    );
  }

  if (!profile || !realAi) {
    return (
      <div className="agent-shell flex items-center justify-center px-6">
        <GateCard
          title="No AI provider configured"
          body="Add a provider under Plugins and validate an API key to start delegating engineering work."
          action={{ to: '/plugins', label: 'Configure a provider' }}
        />
      </div>
    );
  }

  // --- shared chrome pieces ------------------------------------------------
  const modelCard = (
    <div ref={modelRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setModelOpen(o => !o);
          setRepoOpen(false);
          setModeOpen(false);
        }}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-full text-[12px] text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
      >
        <span className="w-4 h-4 rounded-full bg-surface-subtle border border-border-subtle flex items-center justify-center">
          <Plus className="w-2.5 h-2.5" />
        </span>
        <span className="font-medium">{modelLabel(activeModelLabel) || 'Model'}</span>
        <span className="text-[10px] uppercase tracking-wider text-txt-tertiary">
          {effortBadge(workingReasoning)}
        </span>
        <ChevronDown className="w-3 h-3 text-txt-tertiary" />
      </button>
      {modelOpen && (
        <div className="absolute left-0 bottom-[calc(100%+8px)] w-[22rem] rounded-xl border border-border-subtle bg-surface-canvas shadow-xl z-40 overflow-hidden animate-pop">
          <div className="px-3 py-2 border-b border-border-subtle">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-txt-tertiary">
              Model
            </p>
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {(modelOptions.length ? modelOptions : [activeModelLabel].filter(Boolean)).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => changeModel(m)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-[12px] transition ${
                  m === workingModel ? 'bg-surface-subtle' : 'hover:bg-surface-subtle'
                }`}
              >
                <span
                  className={`truncate font-mono ${
                    m === workingModel ? 'text-txt-primary' : 'text-txt-secondary'
                  }`}
                >
                  {modelLabel(m)}
                </span>
                <span
                  className={`shrink-0 text-[9px] uppercase tracking-wider rounded-md border px-1.5 py-0.5 ${
                    workingReasoning === 'none'
                      ? 'border-border-subtle text-txt-tertiary'
                      : 'border-emerald-400/25 bg-emerald-400/10 text-emerald-400'
                  }`}
                >
                  {effortBadge(workingReasoning)}
                </span>
              </button>
            ))}
          </div>
          <div className="border-t border-border-subtle px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-txt-tertiary mb-2">
              Reasoning effort
            </p>
            <div className="grid grid-cols-4 gap-1">
              {['none', 'low', 'medium', 'high'].map(r => (
                <button
                  key={r}
                  type="button"
                  onClick={() => changeReasoning(r)}
                  className={`text-[11px] capitalize py-1.5 rounded-md border transition ${
                    r === workingReasoning
                      ? 'border-border-mid bg-surface-subtle text-txt-primary'
                      : 'border-transparent text-txt-tertiary hover:text-txt-secondary hover:bg-surface-subtle'
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
  );

  const composer = (
    <div
      className={`w-full rounded-2xl border border-border-subtle bg-surface-canvas shadow-lg transition focus-within:border-border-mid focus-within:border-border-mid ${
        empty ? 'max-w-[40rem]' : 'max-w-3xl'
      }`}
    >
      <div className="px-3 pt-3">
        <ComposerAttach images={pendingImages} onRemove={id => setPendingImages(imgs => imgs.filter(i => i.id !== id))} />
      </div>
      <textarea
        ref={textareaRef}
        rows={empty ? 3 : 1}
        value={input}
        onChange={e => {
          setInput(e.target.value);
          const el = e.target;
          el.style.height = 'auto';
          el.style.height = Math.min(el.scrollHeight, empty ? 220 : 160) + 'px';
        }}
        onKeyDown={handleKeyDown}
        onPaste={async e => {
          const files = imageFilesFromClipboard(e.clipboardData);
          if (files.length === 0) return;
          e.preventDefault();
          const { next } = await appendPastedImages(pendingImages, files);
          setPendingImages(next);
        }}
        placeholder={
          mode === 'agent'
            ? 'Plan, Build, / for tools, @ for context'
            : mode === 'plan'
              ? 'Describe what to plan…'
              : mode === 'debug'
                ? 'Describe the bug…'
                : 'Ask anything about this repo…'
        }
        disabled={streaming || !activeRepo}
        className={`w-full resize-none bg-transparent text-txt-primary placeholder:text-txt-tertiary outline-none px-4 pt-3.5 pb-2 disabled:opacity-50 ${
          empty ? 'text-[15px] leading-relaxed min-h-[84px]' : 'text-[13px] min-h-[44px] max-h-40'
        }`}
      />
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
        {modelCard}
        {streaming ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            title="Stop (Esc)"
            className="w-8 h-8 rounded-full flex items-center justify-center bg-surface-subtle text-txt-primary hover:bg-surface-mid transition"
          >
            <Square className="w-3.5 h-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => send()}
            disabled={(!input.trim() && pendingImages.length === 0) || !activeRepo}
            title="Send"
            className="w-8 h-8 rounded-full flex items-center justify-center bg-txt-primary text-surface-base hover:opacity-90 disabled:opacity-25 disabled:cursor-not-allowed transition"
          >
            <ArrowUp className="w-4 h-4" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );

  // --- layout --------------------------------------------------------------
  return (
    <div className="agent-shell flex bg-surface-base text-txt-primary">
      {/* Left rail — quiet session list */}
      <aside className="hidden md:flex flex-col w-[15.5rem] shrink-0 border-r border-border-subtle bg-surface-canvas">
        <div className="p-3 pb-2">
          <button
            type="button"
            onClick={startNew}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition ${
              empty
                ? 'bg-surface-subtle text-txt-primary'
                : 'text-txt-secondary hover:bg-surface-subtle hover:text-txt-primary'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            New Agent
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-3">
          {groupedSessions.length === 0 ? (
            <p className="px-3 py-4 text-[11px] leading-relaxed text-txt-tertiary">
              Past agent tasks land here, grouped by repo.
            </p>
          ) : (
            groupedSessions.map(([groupPath, convs]) => (
              <div key={groupPath}>
                <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-txt-tertiary">
                  <FolderGit2 className="w-3 h-3 shrink-0 opacity-70" />
                  <span className="truncate">{groupPath}</span>
                </div>
                <div className="space-y-0.5">
                  {convs.map(c => (
                    <div
                      key={c.id}
                      className={`group flex items-center gap-1 rounded-md pl-2.5 pr-1 py-1.5 cursor-pointer transition ${
                        c.id === currentId
                          ? 'bg-surface-subtle text-txt-primary'
                          : 'text-txt-secondary hover:bg-surface-subtle hover:text-txt-primary'
                      }`}
                      onClick={() => openConversation(c)}
                    >
                      <span className="flex-1 min-w-0 truncate text-[12.5px] leading-snug">
                        {c.title || 'Untitled'}
                      </span>
                      <span className="text-[10px] text-txt-tertiary tabular-nums shrink-0 group-hover:hidden">
                        {relativeAge(c.updatedAt)}
                      </span>
                      <button
                        type="button"
                        title="Delete"
                        onClick={e => {
                          e.stopPropagation();
                          deleteConversation(c.id)
                            .then(() => {
                              if (currentId === c.id) startNew();
                            })
                            .catch(() => {})
                            .finally(refreshSessions);
                        }}
                        className="hidden group-hover:flex p-1 rounded text-txt-tertiary hover:text-rose-400 transition"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Main canvas */}
      <div className="flex-1 min-w-0 flex flex-col relative">
        {/* Top chrome — only when a session is open */}
        {!empty && (
          <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-txt-primary truncate">
                {allConversations.find(c => c.id === currentId)?.title || 'Agent'}
              </p>
              <p className="text-[11px] text-txt-tertiary truncate font-mono">
                {activeRepo} · {getMode(mode).label}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {lastTurnMetrics(trace) && (
                <span
                  className="hidden sm:inline font-mono text-[10px] text-txt-tertiary"
                  title="Last turn — logged for distillation"
                >
                  {lastTurnMetrics(trace)!.tokensPerSecond} tok/s · {lastTurnMetrics(trace)!.modelId}
                </span>
              )}
              {trace.length > 0 && (
                <button
                  type="button"
                  title="Download session JSONL for distillation"
                  onClick={() =>
                    downloadJsonl(
                      `${(allConversations.find(c => c.id === currentId)?.title || 'agent-session').slice(0, 48)}.jsonl`,
                      trace,
                    )
                  }
                  className="p-1.5 rounded-md text-txt-tertiary hover:text-txt-secondary hover:bg-surface-subtle transition"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              )}
              {activeRepo.includes('/') && (
                <Link
                  to={`/${activeRepo}/assistant`}
                  className="text-[11px] px-2.5 py-1 rounded-md text-txt-tertiary hover:text-txt-secondary hover:bg-surface-subtle transition"
                >
                  Repo assistant
                </Link>
              )}
              <button
                type="button"
                onClick={startNew}
                className="text-[11px] px-2.5 py-1 rounded-md border border-border-subtle text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
              >
                New
              </button>
            </div>
          </div>
        )}

        {/* Body */}
        {empty ? (
          <div className="flex-1 flex flex-col items-center justify-center px-6 pb-16">
            {/* Context strip above the card — Cursor's "nahenet ∨ main ∨ Local" */}
            <div className="flex items-center gap-1 mb-3 text-[12px] text-txt-tertiary">
              <div ref={repoMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setRepoOpen(o => !o);
                    setModelOpen(false);
                    setModeOpen(false);
                  }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-surface-subtle hover:text-txt-secondary transition"
                >
                  <span className="font-mono text-txt-secondary">
                    {activeRepo || 'pick a repo'}
                  </span>
                  <ChevronDown className="w-3 h-3" />
                </button>
                {repoOpen && (
                  <div className="absolute left-1/2 -translate-x-1/2 top-[calc(100%+6px)] w-64 max-h-64 overflow-y-auto rounded-xl border border-border-subtle bg-surface-canvas shadow-2xl z-40 py-1 animate-pop">
                    {repos.length === 0 ? (
                      <p className="px-3 py-2 text-[12px] text-txt-tertiary">No repos yet.</p>
                    ) : (
                      repos.map(r => (
                        <button
                          key={r.path}
                          type="button"
                          onClick={() => {
                            setRepoOpen(false);
                            if (r.path !== activeRepo) changeRepo(r.path);
                          }}
                          className={`w-full text-left px-3 py-1.5 text-[12px] font-mono truncate transition ${
                            r.path === activeRepo
                              ? 'bg-surface-subtle text-txt-primary'
                              : 'text-txt-secondary hover:bg-surface-subtle'
                          }`}
                        >
                          {r.path}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <span className="opacity-30">·</span>
              <div ref={modeMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setModeOpen(o => !o);
                    setRepoOpen(false);
                    setModelOpen(false);
                  }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-surface-subtle hover:text-txt-secondary transition"
                >
                  <span className="text-txt-secondary">{getMode(mode).label}</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
                {modeOpen && (
                  <div className="absolute left-1/2 -translate-x-1/2 top-[calc(100%+6px)] w-72 rounded-xl border border-border-subtle bg-surface-canvas shadow-2xl z-40 py-1 animate-pop">
                    {ASSISTANT_MODES.map(m => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => changeMode(m.id)}
                        className={`w-full text-left px-3 py-2 transition ${
                          m.id === mode ? 'bg-surface-subtle' : 'hover:bg-surface-subtle'
                        }`}
                      >
                        <div
                          className={`text-[12.5px] font-medium ${
                            m.id === mode ? 'text-txt-primary' : 'text-txt-secondary'
                          }`}
                        >
                          {m.label}
                        </div>
                        <div className="text-[11px] text-txt-tertiary leading-snug mt-0.5">
                          {m.description}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {composer}

            {/* Quick chips */}
            <div className="flex flex-wrap items-center justify-center gap-2 mt-4 max-w-[40rem]">
              {QUICK_CHIPS.map(chip => (
                <button
                  key={chip.label}
                  type="button"
                  onClick={() => send(chip.prompt)}
                  disabled={!activeRepo || streaming}
                  className="px-3 py-1.5 rounded-full border border-border-subtle text-[12px] text-txt-tertiary hover:text-txt-secondary hover:border-border-mid hover:bg-surface-subtle/70 disabled:opacity-40 transition"
                >
                  {chip.label}
                </button>
              ))}
            </div>

            <p className="mt-10 text-[11px] text-txt-tertiary">
              Use{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-surface-subtle border border-border-subtle font-mono text-[10px]">
                @file
              </kbd>{' '}
              to attach code ·{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-surface-subtle border border-border-subtle font-mono text-[10px]">
                Enter
              </kbd>{' '}
              to send
            </p>
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="flex-1 overflow-y-auto">
              <div className="max-w-3xl mx-auto px-5 py-8 space-y-7">
                {messages
                  .filter(msg => (msg as { kind?: string }).kind !== 'session_trace')
                  .map((msg, i, visible) =>
                  (msg as { kind?: string }).kind === 'compaction' ? (
                    <p
                      key={msg.id}
                      className="text-center text-[10px] uppercase tracking-wider text-txt-tertiary py-2"
                    >
                      Context compacted
                    </p>
                  ) : (
                    <ChatMessageView
                      key={msg.id}
                      message={msg}
                      streaming={
                        streaming && i === visible.length - 1 && msg.role === 'assistant'
                      }
                    />
                  ),
                )}
              </div>
            </div>

            {/* Docked floating composer */}
            <div className="px-5 pb-5 pt-2 flex flex-col items-center">
              <div className="w-full max-w-3xl flex items-center justify-center gap-2 mb-2 text-[11px] text-txt-tertiary">
                <button
                  type="button"
                  onClick={() => {
                    setRepoOpen(o => !o);
                    setModelOpen(false);
                    setModeOpen(false);
                  }}
                  className="font-mono hover:text-txt-secondary transition"
                >
                  {activeRepo}
                </button>
                <span className="opacity-30">·</span>
                <button
                  type="button"
                  onClick={() => {
                    setModeOpen(o => !o);
                    setRepoOpen(false);
                    setModelOpen(false);
                  }}
                  className="hover:text-txt-secondary transition"
                >
                  {getMode(mode).label}
                </button>
              </div>
              {composer}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const GateCard: React.FC<{
  title: string;
  body: string;
  action: { to: string; label: string };
}> = ({ title, body, action }) => (
  <div className="max-w-sm text-center">
    <div className="mx-auto w-11 h-11 rounded-2xl bg-surface-subtle border border-border-subtle flex items-center justify-center mb-4">
      <Bot className="w-5 h-5 text-txt-tertiary" />
    </div>
    <h1 className="text-[15px] font-medium text-txt-primary mb-1.5">{title}</h1>
    <p className="text-[13px] text-txt-tertiary leading-relaxed mb-5">{body}</p>
    <Link
      to={action.to}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-txt-primary text-surface-base text-[12.5px] font-medium hover:opacity-90 transition"
    >
      {action.label}
    </Link>
  </div>
);
