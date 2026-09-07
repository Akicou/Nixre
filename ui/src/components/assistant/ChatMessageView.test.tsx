import { it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
