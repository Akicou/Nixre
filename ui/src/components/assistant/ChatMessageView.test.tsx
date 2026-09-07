import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { afterEach } from 'vitest';
import { ChatMessageView, ToolBlockView } from './ChatMessageView';

afterEach(cleanup);

it('opens an image tool card when its streamed result arrives', () => {
  const tool = { id: 't', name: 'show_images', status: 'running' as const };
  const { rerender } = render(<ToolBlockView tool={tool} />);
  rerender(<ToolBlockView tool={{ ...tool, status: 'success', output: JSON.stringify({ images: [
    { path: 'preview.png', dataUrl: 'data:image/png;base64,AAAA' },
  ] }) }} />);
  expect(screen.getByRole('img', { name: 'preview.png' })).toBeVisible();
});

const imageTool = {
  id: 'image-tool', name: 'show_images', status: 'success' as const,
  output: JSON.stringify({ images: [{ path: 'preview.png', dataUrl: 'data:image/png;base64,AAAA' }] }),
};

it.each(['close button', 'Escape', 'backdrop'])('closes a Show Images preview using %s and restores focus', method => {
  const { container } = render(<div className="chat-part-in"><ToolBlockView tool={imageTool} /></div>);
  const thumbnail = screen.getByTitle('preview.png');
  fireEvent.click(thumbnail);
  const dialog = screen.getByRole('dialog', { name: 'Image preview: preview.png' });
  expect(container).not.toContainElement(dialog);
  expect(dialog.parentElement).toBe(document.body);
  const close = within(dialog).getByRole('button', { name: 'Close image preview' });
  expect(close).toHaveFocus();
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.click(within(dialog).getByRole('img'));
  expect(dialog).toBeInTheDocument();
  fireEvent.keyDown(close, { key: 'Tab' });
  expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(close).toHaveFocus();
  if (method === 'close button') fireEvent.click(close);
  else if (method === 'Escape') fireEvent.keyDown(close, { key: 'Escape' });
  else fireEvent.click(dialog);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(thumbnail).toHaveFocus();
  expect(document.body.style.overflow).toBe('');
  expect(screen.getByRole('img', { name: 'preview.png' })).toBeVisible();
  fireEvent.click(thumbnail);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('cleans up the preview and restores scrolling when its tool card unmounts', () => {
  document.body.style.overflow = 'auto';
  const { unmount } = render(<ToolBlockView tool={imageTool} />);
  fireEvent.click(screen.getByTitle('preview.png'));
  unmount();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.body.style.overflow).toBe('auto');
  const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  document.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(false);
  document.body.style.overflow = '';
});

it('does not resend an empty edit or submit while composing with an IME', () => {
  const onEdit = vi.fn();
  render(<ChatMessageView message={{ id: 'u', role: 'user', content: 'hello', createdAt: 1 }} onEdit={onEdit} />);
  fireEvent.click(screen.getByTitle('Edit & resend'));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '   ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onEdit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: 'new text' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(onEdit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onEdit).toHaveBeenCalledWith('u', 'new text');
});
