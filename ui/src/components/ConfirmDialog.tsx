import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ConfirmDialogProps {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Small modal that asks before something with a cost (tokens, commands) starts.
 * Enter confirms, Escape or a click on the backdrop cancels, Tab stays inside, and focus
 * returns to the button that opened it. Rendered in a portal so animated parents cannot clip it.
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}) => {
  const titleId = useId();
  const bodyId = useId();
  const confirm = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirm.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const next = document.activeElement === confirm.current ? cancel.current : confirm.current;
        next?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={event => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="w-full max-w-sm rounded-2xl border border-border-subtle bg-surface-canvas p-5 shadow-2xl animate-pop"
      >
        <h2 id={titleId} className="text-[15px] font-semibold text-txt-primary">{title}</h2>
        <div id={bodyId} className="mt-2 text-[13px] leading-relaxed text-txt-secondary">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancel}
            type="button"
            onClick={onCancel}
            className="min-h-10 rounded-lg border border-border-subtle px-4 text-[13px] text-txt-secondary hover:bg-surface-subtle hover:text-txt-primary transition"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirm}
            type="button"
            onClick={onConfirm}
            className="min-h-10 rounded-lg bg-txt-primary px-4 text-[13px] font-medium text-surface-base hover:opacity-90 transition"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

/** Shared wording for the "environment feedback" button in both composers. */
export const EnvAuditConfirmBody: React.FC = () => (
  <>
    The agent will probe its sandbox and Nixre tools, save a report of what is missing (you and the instance admins can read it),
    and summarize what is missing versus blocked by a permission. It runs commands in the sandbox and uses tokens. It will not edit the Dockerfile.
  </>
);
