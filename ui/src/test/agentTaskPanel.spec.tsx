import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AgentTaskPanel } from '../components/assistant/AgentTaskPanel';
const initial = () => ({
  settings: { preset: 'workspace', autoVerify: false, maxTokens: 10000, maxCost: 0, inputPrice: 1, outputPrice: 2, maxSeconds: 300 },
  memory: 'Use TypeScript', canResume: true, interrupted: true, startedAt: Date.now(), finishedAt: null,
  plan: [{ text: 'Inspect auth', status: 'completed' }, { text: 'Fix auth', status: 'blocked', blocker: 'Needs test fixture' }],
  proposals: [{ id: 'p', path: 'a.ts', before: 'const a = 1;', content: 'const a = 2;', patch: '-const a = 1;\n+const a = 2;', status: 'pending' }],
  approvals: [], checkpoints: [{ id: 'cp', label: 'Before task', files: 2, createdAt: Date.now() }], specialists: [],
  usage: { input: 50, output: 25, estimatedCost: .0001 }, verification: null, browser: null,
});
let state = initial();
let requests: any[];
beforeEach(() => {
  state = initial(); requests = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const action = JSON.parse(String(init.body)); requests.push(action);
      if (action.type === 'proposal') state.proposals[0].status = action.accept ? 'accepted' : 'rejected';
      if (action.type === 'resume') return new Response(JSON.stringify({ ...state, resumed: 'c' }));
    }
    return new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('AgentTaskPanel', () => {
  it('shows plan blockers, usage, diffs, and accepts one reviewed file', async () => {
    render(<AgentTaskPanel conversationId="c" running={false} onResume={() => {}} />);
    expect(await screen.findByText('Needs test fixture')).toBeInTheDocument();
    expect(screen.getByText(/75 tokens/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Changes, checkpoints, and checks'));
    fireEvent.click(screen.getByText('a.ts · modified'));
    expect(screen.getByLabelText('Diff for a.ts')).toHaveTextContent('+const a = 2;');
    fireEvent.click(screen.getByRole('button', { name: 'Accept file' }));
    await waitFor(() => expect(requests).toContainEqual({ type: 'proposal', id: 'p', accept: true }));
  });
  it('keeps workspace mutations disabled while a task is running but allows approval', async () => {
    (state.approvals as any[]).push({ id: 'a', tool: 'run_command', args: { command: 'npm test' }, status: 'pending' });
    render(<AgentTaskPanel conversationId="c" running onResume={() => {}} />);
    fireEvent.click(await screen.findByText('Changes, checkpoints, and checks'));
    expect(screen.getByRole('button', { name: 'Restore files' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve once' }));
    await waitFor(() => expect(requests).toContainEqual({ type: 'approval', id: 'a', accept: true }));
  });
  it('saves editable project memory and reconnects to a resumed task', async () => {
    const resume = vi.fn();
    render(<AgentTaskPanel conversationId="c" running={false} onResume={resume} />);
    fireEvent.click(await screen.findByText('Permissions, limits, and project memory'));
    fireEvent.change(screen.getByLabelText('Project memory'), { target: { value: 'Use strict TypeScript' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save project memory' }));
    await waitFor(() => expect(requests).toContainEqual({ type: 'memory', content: 'Use strict TypeScript' }));
    fireEvent.click(screen.getByText('Changes, checkpoints, and checks'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume saved task' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Resume saved task' }));
    await waitFor(() => expect(resume).toHaveBeenCalledOnce());
  });
});
