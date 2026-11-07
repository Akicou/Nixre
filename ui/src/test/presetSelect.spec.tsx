import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PresetSelect } from '../components/assistant/PresetSelect';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => ({
    ok: true, json: async () => ({ settings: { preset: init?.method === 'POST' ? JSON.parse(String(init.body)).settings.preset : 'workspace', autoVerify: true } }),
  }));
});

describe('PresetSelect', () => {
  it('keeps the choice locally for a new task', () => {
    const onNew = vi.fn();
    render(<PresetSelect conversationId={null} newPreset="workspace" onNewPreset={onNew} running={false} />);
    fireEvent.change(screen.getByLabelText('New task permissions'), { target: { value: 'auto' } });
    expect(onNew).toHaveBeenCalledWith('auto');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads and saves the preset of an existing task, and locks while it runs', async () => {
    const { rerender } = render(<PresetSelect conversationId="c1" newPreset="workspace" onNewPreset={() => {}} running={false} />);
    const select = await screen.findByLabelText('Task permissions');
    await waitFor(() => expect(select).not.toBeDisabled());
    fireEvent.change(select, { target: { value: 'auto' } });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('auto'));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(post![1].body)).toEqual({ type: 'settings', settings: { preset: 'auto', autoVerify: true } });
    rerender(<PresetSelect conversationId="c1" newPreset="workspace" onNewPreset={() => {}} running />);
    expect(select).toBeDisabled();
  });
});
