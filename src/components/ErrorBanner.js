// Shows the standard error message from the API. Never a stack trace: servers do not send one.
export default function ErrorBanner({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div role="alert" className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <span>{message}</span>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className="font-semibold text-red-700 hover:underline" aria-label="Dismiss error">
          Dismiss
        </button>
      ) : null}
    </div>
  );
}
