import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatMessageView } from '../components/assistant/ChatMessageView';
import { applyEvent } from '../lib/assistantEngine';

function requestMessage(id = 'approval-1') {
  const started = applyEvent([], { type: 'tool_start', tool: { id: 'cmd', name: 'run_command', status: 'running', argsText: '{"command":"npm test"}' } });
  return applyEvent(started, { type: 'tool_approval', toolId: 'cmd', approvalId: id, conversationId: 'conv' })[0];
}
beforeEach(() => {
  localStorage.setItem('nixre_token', 'test-session');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
});
afterEach(() => { vi.unstubAllGlobals(); });

it('shows a streamed approval inline and notifies without opening task controls', async () => {
  const message = requestMessage();
  const view = render(<ChatMessageView message={message} streaming />);
  expect(screen.getByRole('alert')).toHaveTextContent('Command approval needed');
  expect(screen.getByRole('status')).toHaveTextContent('has not run');
  expect(screen.getByText('npm test')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Review command' }));
  expect(screen.getByLabelText('Approval for run_command')).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Approve command' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/ai/jobs/conv/controls', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ type: 'approval', id: 'approval-1', accept: true }),
  })));
  expect(await screen.findByText('Approved. The command can now run.')).toBeInTheDocument();
  const approved = applyEvent([message], { type: 'tool_approved', toolId: 'cmd' })[0];
  view.rerender(<ChatMessageView message={approved} streaming />);
  expect(screen.queryByText('Approval needed')).not.toBeInTheDocument();
});

it('can deny a command directly in the transcript', async () => {
  render(<ChatMessageView message={requestMessage('denied')} streaming />);
  fireEvent.click(screen.getByRole('button', { name: 'Deny command' }));
  expect(await screen.findByText('Denied. The command will not run.')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ type: 'approval', id: 'denied', accept: false }) }));
});

it('restores approval buttons from a persisted snapshot', () => {
  const restored = JSON.parse(JSON.stringify(requestMessage('restored')));
  render(<ChatMessageView message={restored} streaming />);
  expect(screen.getByRole('button', { name: 'Approve command' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Deny command' })).toBeEnabled();
});

it('shows response errors without claiming the command was approved', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('{"message":"Approval is no longer active"}', { status: 409 }));
  render(<ChatMessageView message={requestMessage('expired')} streaming />);
  fireEvent.click(screen.getByRole('button', { name: 'Approve command' }));
  expect(await screen.findByText('Approval is no longer active')).toBeInTheDocument();
  expect(screen.queryByText('Approved. The command can now run.')).not.toBeInTheDocument();
});

it('sends a desktop notification for a background tab when permission is granted', () => {
  const notify = vi.fn(function () { return { close: vi.fn() }; });
  Object.assign(notify, { permission: 'granted' });
  vi.stubGlobal('Notification', notify);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  const view = render(<ChatMessageView message={requestMessage('desktop')} streaming />);
  expect(notify).toHaveBeenCalledWith('Nixre needs your approval', expect.objectContaining({ body: 'Review run_command before it runs.' }));
  view.unmount();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
