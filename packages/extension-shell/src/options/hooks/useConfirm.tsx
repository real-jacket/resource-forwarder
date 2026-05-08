import React, { useCallback, useEffect, useRef, useState } from "react";
import { useModalDismiss } from "./useModalDismiss.js";

export interface ConfirmOptions {
  title: string;
  /** Body text. Newlines are honored — they render as separate paragraphs. */
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** Style the confirm button as destructive (red) when true. */
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

/**
 * Replacement for `window.confirm` that renders an accessible in-app dialog
 * instead of the browser's blocking native modal.
 *
 * Why not use `window.confirm`?
 *  - In Chrome extension contexts (popup / options page) `window.confirm`
 *    can be blocked, surface inconsistent OS chrome, or detach from the
 *    extension's visual identity.
 *  - It blocks JS in a way that prevents async cleanup or status updates.
 *  - It is not styleable and ignores the page's accessibility tree.
 *
 * Usage:
 * ```tsx
 * const { confirm, dialog } = useConfirm();
 * const ok = await confirm({ title: "..", message: "..", danger: true });
 * if (!ok) return;
 * // ...
 * return <>{...}{dialog}</>
 * ```
 *
 * The dialog renders only while a confirmation is pending. Multiple calls
 * stack via the underlying `useModalDismiss` so ESC closes the topmost
 * confirmation as expected.
 */
export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  dialog: React.ReactNode;
} {
  const [state, setState] = useState<ConfirmState | null>(null);
  // Ref so the close handler captured by useModalDismiss always sees the
  // latest pending resolver instead of a stale closure.
  const stateRef = useRef<ConfirmState | null>(state);
  stateRef.current = state;

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...options, resolve });
    });
  }, []);

  const handleClose = useCallback((value: boolean) => {
    const current = stateRef.current;
    if (!current) return;
    setState(null);
    current.resolve(value);
  }, []);

  return {
    confirm,
    dialog: state ? (
      <ConfirmDialog
        key={state.title + state.message}
        options={state}
        onClose={handleClose}
      />
    ) : null,
  };
}

function ConfirmDialog({
  options,
  onClose,
}: {
  options: ConfirmOptions;
  onClose: (value: boolean) => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // ESC dismisses with `false`. Same focus-restoration semantics as the
  // other modals in the app.
  useModalDismiss(true, () => onClose(false));

  // Focus the confirm button on mount. Cancel-by-default would be safer for
  // truly destructive actions but the call sites already include explicit
  // copy ("此操作不可撤销") and a danger color, and users expect Enter to
  // commit when they consciously open a confirmation.
  useEffect(() => {
    const id = window.setTimeout(() => confirmRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  const lines = options.message.split("\n");

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div className="modal-box modal-confirm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-box-header">
          <span className="modal-box-title" id="confirm-dialog-title">{options.title}</span>
          <button
            className="btn-icon"
            onClick={() => onClose(false)}
            aria-label="关闭"
            title="关闭"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-box-body">
          {lines.map((line, i) => (
            <p key={i} className="modal-confirm-line">{line}</p>
          ))}
        </div>
        <div className="modal-box-footer">
          <button className="btn btn-ghost" onClick={() => onClose(false)}>
            {options.cancelText ?? "取消"}
          </button>
          <button
            ref={confirmRef}
            className={`btn ${options.danger ? "btn-danger" : "btn-primary"}`}
            onClick={() => onClose(true)}
          >
            {options.confirmText ?? "确认"}
          </button>
        </div>
      </div>
    </div>
  );
}
