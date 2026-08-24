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
  PanelLeft,
  Plus,
  Sparkles,
  Square,
  Trash2,
  CornerDownRight,
  Pencil,
  Undo2,
} from 'lucide-react';
import { api } from '../lib/api';
import { isPluginLive } from '../lib/pluginPreferences';
import {
  getActiveProviderProfile,
  isRealAi,
  type AssistantProviderProfile,
} from '../lib/assistantProfiles';
import { ASSISTANT_MODES, getMode, type ModeId } from '../lib/assistantModes';
import { modelLabel } from '../lib/aiApi';
import {
  listConversations,
  updateConversation,
  deleteConversation,
  applyEvent,
  messageParts,
  getConversation,
  type ChatMessage,
  type Conversation,
  type EngineEvent,
} from '../lib/assistantEngine';
import { peelTrace } from '../lib/sessionTrace';
import {
  startAgentJob,
  stopAgentJob,
  queueAgentJob,
  deleteQueuedJob,
  subscribeAgentJob,
  queueToLocal,
  type JobStreamEvent,
  type RunQueueItem,
} from '../lib/agentJobs';
import { ChatMessageView } from '../components/assistant/ChatMessageView';
import { ComposerAttach } from '../components/assistant/ComposerAttach';
import { ComposerMic } from '../components/assistant/ComposerMic';
import { MobileDrawer } from '../components/MobileDrawer';
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

interface QueuedMessage {
  id: string;
  text: string;
  images: ChatImage[];
  kind?: RunQueueItem['kind'];
  deleted?: boolean;
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
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);
  const [trace, setTrace] = useState<SessionTraceEntry[]>([]);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const repoMenuRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const followAbortRef = useRef<AbortController | null>(null);
  const traceRef = useRef<SessionTraceEntry[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const currentIdRef = useRef<string | null>(null);
  const queuedRef = useRef<QueuedMessage[]>([]);
  const streamingRef = useRef(false);

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
      followAbortRef.current?.abort();
      setSearchParams(path ? { repo: path } : {});
      setCurrentId(null);
      currentIdRef.current = null;
      setMessages([]);
      setTrace([]);
      traceRef.current = [];
      setInput('');
      setQueued([]);
      queuedRef.current = [];
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
  useEffect(() => {
    queuedRef.current = queued;
  }, [queued]);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  const persistTrace = (
    next: SessionTraceEntry[],
    msgs = messagesRef.current,
    title?: string,
  ) => {
    traceRef.current = next;
    setTrace(next);
    const id = currentIdRef.current;
    if (!id || !activeRepo || streamingRef.current) return;
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

  const applyStreamEvent = useCallback((ev: JobStreamEvent) => {
    if (ev.type === 'heartbeat' || ev.type === 'usage') return;
    if (ev.type === 'snapshot') {
      const raw = Array.isArray(ev.conversation.messages) ? ev.conversation.messages : [];
      const { messages: next, trace: nextTrace } = peelTrace(raw as ChatMessage[]);
      setMessages(next);
      setTrace(nextTrace);
      traceRef.current = nextTrace;
      const q = queueToLocal(ev.conversation.run_queue);
      queuedRef.current = q;
      setQueued(q);
      const running =
        ev.conversation.run_status === 'running' || ev.conversation.run_status === 'stopping';
      setStreaming(running);
      messagesRef.current = next;
      return;
    }
    if (ev.type === 'queue') {
      const q = queueToLocal(ev.items);
      queuedRef.current = q;
      setQueued(q);
      return;
    }
    if (ev.type === 'status') {
      const running = ev.run_status === 'running' || ev.run_status === 'stopping';
      setStreaming(running);
      if (!running) refreshSessions();
      return;
    }
    if (ev.type === 'done') {
      setStreaming(false);
      refreshSessions();
      return;
    }
    setMessages(prev => {
      const next = applyEvent(messagesRef.current, ev as EngineEvent);
      messagesRef.current = next;
      return next;
    });
  }, [refreshSessions]);

  const attachFollow = useCallback((id: string) => {
    followAbortRef.current?.abort();
    const ac = new AbortController();
    followAbortRef.current = ac;
    setStreaming(true);
    const follow = async () => {
      try {
        await subscribeAgentJob(id, applyStreamEvent, ac.signal);
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError') return;
      }
      if (ac.signal.aborted) return;
      while (!ac.signal.aborted) {
        const conv = await getConversation(id).catch(() => undefined);
        if (!conv) break;
        setMessages(conv.messages);
        const running = conv.runStatus === 'running' || conv.runStatus === 'stopping';
        setStreaming(running);
        if (!running) {
          refreshSessions();
          return;
        }
        await new Promise(r => setTimeout(r, 2000));
        try {
          await subscribeAgentJob(id, applyStreamEvent, ac.signal);
          return;
        } catch (err: unknown) {
          if ((err as Error)?.name === 'AbortError') return;
        }
      }
    };
    void follow();
  }, [applyStreamEvent, refreshSessions]);

  useEffect(() => {
    return () => {
      followAbortRef.current?.abort();
    };
  }, []);

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
      if (e.key === 'Escape' && streaming && currentIdRef.current) {
        void stopAgentJob(currentIdRef.current).catch(() => {});
      }
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
  const sendToJob = async (prompt: string, images: ChatImage[] = []) => {
    if (!realAi || !profile || !activeRepo) return;
    setStreaming(true);
    try {
      const result = await startAgentJob({
        conversationId: currentIdRef.current,
        repoPath: activeRepo,
        prompt,
        images: images.length ? images : undefined,
        mode,
        model: workingModel || profile.model,
        reasoningLevel: workingReasoning,
      });
      currentIdRef.current = result.conversationId;
      setCurrentId(result.conversationId);
      if (result.queued) {
        if (result.item) {
          const q: QueuedMessage[] = [
            ...queuedRef.current,
            { id: result.item.id, text: result.item.text, images: result.item.images ?? [], kind: result.item.kind },
          ];
          queuedRef.current = q;
          setQueued(q);
        }
        return;
      }
      attachFollow(result.conversationId);
      refreshSessions();
    } catch (err: unknown) {
      setStreaming(false);
      const msg = err instanceof Error ? err.message : 'Could not start the agent job.';
      setMessages(prev => applyEvent(prev, { type: 'message_text', text: `\n\n> ⚠️ ${msg}` }));
    }
  };

  const send = (text?: string) => {
    const prompt = (text ?? input).trim();
    if ((!prompt && pendingImages.length === 0) || !realAi) return;
    const images = pendingImages;
    setInput('');
    setPendingImages([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    if (streaming && currentIdRef.current) {
      void queueAgentJob(currentIdRef.current, {
        kind: 'followup',
        text: prompt || '(image)',
        images: images.length ? images : undefined,
      }).then(r => {
        const q = queueToLocal(r.run_queue);
        queuedRef.current = q;
        setQueued(q);
      }).catch(() => {});
      return;
    }
    void sendToJob(prompt || '(image)', images);
  };

  const stop = () => {
    const id = currentIdRef.current;
    if (id) void stopAgentJob(id).catch(() => {});
  };

  const handleSteer = (id: string) => {
    const item = queuedRef.current.find(q => q.id === id);
    const convId = currentIdRef.current;
    if (!item || !convId) return;
    void (async () => {
      await deleteQueuedJob(convId, id).catch(() => {});
      if (!streamingRef.current) {
        void sendToJob(item.text, item.images);
        return;
      }
      const r = await queueAgentJob(convId, {
        kind: 'steer',
        text: item.text,
        images: item.images.length ? item.images : undefined,
      });
      const q = queueToLocal(r.run_queue);
      queuedRef.current = q;
      setQueued(q);
    })();
  };

  const handleEdit = (id: string) => {
    const item = queuedRef.current.find(q => q.id === id);
    const convId = currentIdRef.current;
    if (!item) return;
    if (convId) {
      void deleteQueuedJob(convId, id).then(r => {
        const q = queueToLocal(r.run_queue);
        queuedRef.current = q;
        setQueued(q);
      }).catch(() => {});
    }
    setInput(item.text);
    if (item.images.length) setPendingImages(prev => [...prev, ...item.images]);
    textareaRef.current?.focus();
  };

  const handleDelete = (id: string) => {
    const convId = currentIdRef.current;
    if (!convId) return;
    void deleteQueuedJob(convId, id).then(r => {
      const q = queueToLocal(r.run_queue);
      queuedRef.current = q;
      setQueued(q);
    }).catch(() => {});
  };

  const handleRevert = (id: string) => {
    const item = queuedRef.current.find(q => q.id === id);
    const convId = currentIdRef.current;
    if (!item || !convId) return;
    void queueAgentJob(convId, {
      kind: item.kind || 'followup',
      text: item.text,
      images: item.images.length ? item.images : undefined,
    }).then(r => {
      const q = queueToLocal(r.run_queue);
      queuedRef.current = q;
      setQueued(q);
    }).catch(() => {});
  };

  const startNew = () => {
    followAbortRef.current?.abort();
    setCurrentId(null);
    setMessages([]);
    setInput('');
    setPendingImages([]);
    setTrace([]);
    traceRef.current = [];
    currentIdRef.current = null;
    setQueued([]);
    queuedRef.current = [];
    setStreaming(false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const openConversation = (c: Conversation) => {
    followAbortRef.current?.abort();
    if (c.repoPath !== activeRepo) {
      setSearchParams(c.repoPath ? { repo: c.repoPath } : {});
    }
    setCurrentId(c.id);
    currentIdRef.current = c.id;
    setMessages(c.messages ?? []);
    setTrace(c.trace ?? []);
    traceRef.current = c.trace ?? [];
    setInput('');
    setQueued([]);
    queuedRef.current = [];
    attachFollow(c.id);
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

  const queuePanel =
    queued.length > 0 ? (
      <div className="w-full max-w-3xl mb-2 space-y-1.5">
        <p className="px-1 text-[10px] font-medium uppercase tracking-[0.12em] text-txt-tertiary">
          Queued for the agent
        </p>
        {queued.map(q => (
          <div
            key={q.id}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition ${
              q.deleted
                ? 'border-border-subtle bg-surface-base/40 opacity-50'
                : 'border-border-subtle bg-surface-base'
            }`}
          >
            <span
              className={`flex-1 min-w-0 truncate font-mono ${
                q.deleted ? 'text-txt-tertiary line-through' : 'text-txt-secondary'
              }`}
            >
              {q.text}
              {q.images.length > 0 && <span className="ml-1 text-txt-tertiary">· {q.images.length} img</span>}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {q.deleted ? (
                <button
                  type="button"
                  onClick={() => handleRevert(q.id)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-border-subtle text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
                  title="Restore this message"
                >
                  <Undo2 className="w-3 h-3" />
                  <span>Revert</span>
                </button>
              ) : (
                <>
                  {streaming && (
                    <button
                      type="button"
                      onClick={() => handleSteer(q.id)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-border-subtle text-txt-brand hover:bg-surface-subtle transition"
                      title="Steer the agent right after its current tool call finishes"
                    >
                      <CornerDownRight className="w-3 h-3" />
                      <span>Steer</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleEdit(q.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-border-subtle text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
                    title="Edit this message in the composer"
                  >
                    <Pencil className="w-3 h-3" />
                    <span>Edit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(q.id)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-border-subtle text-txt-tertiary hover:text-feedback-error-text hover:bg-surface-subtle transition"
                    title="Delete this queue entry"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    ) : null;

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
        disabled={!activeRepo}
        className={`w-full resize-none bg-transparent text-txt-primary placeholder:text-txt-tertiary outline-none px-4 pt-3.5 pb-2 disabled:opacity-50 ${
          empty ? 'text-[15px] leading-relaxed min-h-[84px]' : 'text-[13px] min-h-[44px] max-h-40'
        }`}
      />
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
        {modelCard}
        <div className="flex items-center gap-1.5">
          <ComposerMic
            round
            onTranscript={text => setInput(prev => (prev.trim() ? `${prev.trim()} ${text}` : text))}
          />
          {streaming ? (
            <button
              type="button"
              onClick={stop}
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
    </div>
  );

  const pickSession = (c: Conversation) => {
    setSessionDrawerOpen(false);
    openConversation(c);
  };

  const sessionListPanel = (
    <>
      <div className="p-3 pb-2">
        <button
          type="button"
          onClick={() => {
            setSessionDrawerOpen(false);
            startNew();
          }}
          className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[13px] font-medium transition min-h-11 ${
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
                    className={`group flex items-center gap-1 rounded-md pl-2.5 pr-1 py-2 cursor-pointer transition min-h-11 ${
                      c.id === currentId
                        ? 'bg-surface-subtle text-txt-primary'
                        : 'text-txt-secondary hover:bg-surface-subtle hover:text-txt-primary active:bg-surface-subtle'
                    }`}
                    onClick={() => pickSession(c)}
                  >
                    <span className="flex-1 min-w-0 truncate text-[12.5px] leading-snug flex items-center gap-1.5">
                      {(c.runStatus === 'running' || c.runStatus === 'stopping') && (
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0 animate-pulse" title="Agent running" />
                      )}
                      {c.title || 'Untitled'}
                    </span>
                    <span className="text-[10px] text-txt-tertiary tabular-nums shrink-0 sm:group-hover:hidden">
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
                      className="opacity-70 sm:opacity-0 sm:group-hover:opacity-100 flex min-h-11 min-w-11 items-center justify-center rounded text-txt-tertiary hover:text-rose-400 transition shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );

  // Drop direction depends on where the pickers sit: mid-screen in the empty
  // state (down), docked above the bottom composer in a session (up).
  const menuPos = (dropUp: boolean) =>
    dropUp ? 'bottom-[calc(100%_+_6px)]' : 'top-[calc(100%_+_6px)]';

  const repoPickerDropdown = (dropUp: boolean) =>
    repoOpen && (
    <div className={`absolute left-1/2 -translate-x-1/2 ${menuPos(dropUp)} w-[min(16rem,calc(100vw_-_2rem))] z-40`}>
      <div className="max-h-64 overflow-y-auto rounded-xl border border-border-subtle bg-surface-canvas shadow-2xl py-1 animate-pop">
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
              className={`w-full text-left px-3 py-2.5 text-[12px] font-mono truncate transition min-h-11 ${
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
    </div>
  );

  const modePickerDropdown = (dropUp: boolean) =>
    modeOpen && (
    <div className={`absolute left-1/2 -translate-x-1/2 ${menuPos(dropUp)} w-[min(18rem,calc(100vw_-_2rem))] z-40`}>
      <div className="max-h-[min(60vh,24rem)] overflow-y-auto rounded-xl border border-border-subtle bg-surface-canvas shadow-2xl py-1 animate-pop">
        {ASSISTANT_MODES.map(m => (
          <button
            key={m.id}
            type="button"
            onClick={() => changeMode(m.id)}
            className={`w-full text-left px-3 py-2.5 transition min-h-11 ${
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
            <div className="text-[11px] text-txt-tertiary leading-snug mt-0.5">{m.description}</div>
          </button>
        ))}
      </div>
    </div>
  );

  const contextPickers = (dropUp: boolean) => (
    <div className="relative flex items-center gap-1 flex-wrap justify-center text-[12px] text-txt-tertiary">
      <div ref={repoMenuRef}>
        <button
          type="button"
          onClick={() => {
            setRepoOpen(o => !o);
            setModelOpen(false);
            setModeOpen(false);
          }}
          className="flex items-center gap-1 px-2 py-2 rounded-md hover:bg-surface-subtle hover:text-txt-secondary transition min-h-11"
        >
          <span className="font-mono text-txt-secondary truncate max-w-[10rem] sm:max-w-none">
            {activeRepo || 'pick a repo'}
          </span>
          <ChevronDown className="w-3 h-3 shrink-0" />
        </button>
        {repoPickerDropdown(dropUp)}
      </div>
      <span className="opacity-30 hidden sm:inline">·</span>
      <div ref={modeMenuRef}>
        <button
          type="button"
          onClick={() => {
            setModeOpen(o => !o);
            setRepoOpen(false);
            setModelOpen(false);
          }}
          className="flex items-center gap-1 px-2 py-2 rounded-md hover:bg-surface-subtle hover:text-txt-secondary transition min-h-11"
        >
          <span className="text-txt-secondary">{getMode(mode).label}</span>
          <ChevronDown className="w-3 h-3 shrink-0" />
        </button>
        {modePickerDropdown(dropUp)}
      </div>
    </div>
  );

  // --- layout --------------------------------------------------------------
  return (
    <div className="agent-shell flex bg-surface-base text-txt-primary">
      <MobileDrawer
        open={sessionDrawerOpen}
        onClose={() => setSessionDrawerOpen(false)}
        title="Agent tasks"
      >
        {sessionListPanel}
      </MobileDrawer>

      {/* Left rail — desktop only */}
      <aside className="hidden md:flex flex-col w-[15.5rem] shrink-0 border-r border-border-subtle bg-surface-canvas">
        {sessionListPanel}
      </aside>

      {/* Main canvas */}
      <div className="flex-1 min-w-0 flex flex-col relative">
        {/* Top chrome — only when a session is open */}
        {!empty && (
          <div className="flex items-center justify-between gap-2 px-3 sm:px-5 py-3 border-b border-border-subtle">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <button
                type="button"
                onClick={() => setSessionDrawerOpen(true)}
                className="md:hidden shrink-0 min-h-11 min-w-11 flex items-center justify-center rounded-md text-txt-secondary hover:bg-surface-subtle transition"
                title="Past tasks"
                aria-label="Open task list"
              >
                <PanelLeft className="w-5 h-5" />
              </button>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-txt-primary truncate">
                  {allConversations.find(c => c.id === currentId)?.title || 'Agent'}
                </p>
                <p className="text-[11px] text-txt-tertiary truncate font-mono">
                  {activeRepo} · {getMode(mode).label}
                </p>
              </div>
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
          <div className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 pb-16 relative">
            <button
              type="button"
              onClick={() => setSessionDrawerOpen(true)}
              className="md:hidden absolute top-3 left-3 min-h-11 min-w-11 flex items-center justify-center rounded-md text-txt-secondary hover:bg-surface-subtle border border-border-subtle transition"
              title="Past tasks"
              aria-label="Open task list"
            >
              <PanelLeft className="w-5 h-5" />
            </button>
            {contextPickers(false)}
            <div className="h-2" />

            {queuePanel}

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
                {streaming && <AgentWorkingLine messages={messages} queued={queued.filter(q => !q.deleted).length} />}
              </div>
            </div>

            {/* Docked floating composer */}
            <div className="px-3 sm:px-5 pb-5 pt-2 flex flex-col items-center">
              <div className="w-full max-w-3xl mb-2">{contextPickers(true)}</div>
              {queuePanel}
              {composer}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

/** Live activity line under the transcript while a turn is running. */
const AgentWorkingLine: React.FC<{ messages: ChatMessage[]; queued: number }> = ({
  messages,
  queued,
}) => {
  // The most recent tool still marked `running` in the active assistant turn.
  let runningTool: string | null = null;
  for (let i = messages.length - 1; i >= 0 && !runningTool; i--) {
    if (messages[i].role === 'user') break;
    for (const p of messageParts(messages[i])) {
      if (p.type === 'tool' && p.tool.status === 'running') runningTool = p.tool.name;
    }
  }
  const label = runningTool
    ? `Running ${runningTool}…`
    : 'Agent working…';
  return (
    <div className="flex items-center gap-2 text-xs text-txt-tertiary chat-part-in">
      <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" />
      <span>{label}</span>
      {queued > 0 && (
        <span className="text-[10px] text-txt-tertiary/70">
          · {queued} message{queued > 1 ? 's' : ''} queued
        </span>
      )}
      <span className="text-[10px] text-txt-tertiary/70">· Esc to stop</span>
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
