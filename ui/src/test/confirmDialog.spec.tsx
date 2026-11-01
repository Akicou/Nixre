import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';

const Harness = ({ onConfirm }: { onConfirm: () => void }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {open && (
        <ConfirmDialog title="Sure?" confirmLabel="Do it" onCancel={() => setOpen(false)} onConfirm={() => { setOpen(false); onConfirm(); }}>
          It costs tokens.
        </ConfirmDialog>
      )}
    </>
  );
};

describe('ConfirmDialog', () => {
  it('is an accessible modal that focuses the confirm button and restores focus when closed', () => {
    render(<Harness onConfirm={() => {}} />);
    const opener = screen.getByText('open');
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('alertdialog', { name: 'Sure?' });
    expect(dialog).toHaveAccessibleDescription('It costs tokens.');
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(screen.getByRole('button', { name: 'Do it' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Do it' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('confirms once, and cancels from the backdrop', () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByRole('alertdialog').parentElement!);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
