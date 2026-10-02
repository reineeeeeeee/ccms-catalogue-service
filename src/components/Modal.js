'use client';

import { useEffect } from 'react';

export default function Modal({ open, title, onClose, children, footer, widthClass = 'max-w-lg' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label={title} className={`relative w-full ${widthClass} card max-h-[90vh] overflow-y-auto`}>
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-xl">{title}</h2>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-slate-200 px-6 py-4">{footer}</div> : null}
      </div>
    </div>
  );
}
