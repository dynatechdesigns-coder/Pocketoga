// Small shared pieces: data loading, skeletons, error and empty states.
import { useCallback, useEffect, useState } from "react";
import { friendlyError } from "./api.js";

// Runs an async loader on mount. Returns { data, error, loading, reload }.
export function useLoad(loader) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ loading: false, data: await loader(), error: null });
    } catch (err) {
      setState({ loading: false, data: null, error: friendlyError(err) });
    }
  }, [loader]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { ...state, reload };
}

// Grey placeholder blocks the same size as the real cards, so nothing jumps
// when data arrives.
export function Skeleton({ cards = 3, height = 112, label = "Loading" }) {
  return (
    <div className="stack" role="status" aria-label={label}>
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  return (
    <div className="state state-error" role="alert">
      <p className="state-title">That did not load</p>
      <p>{message}</p>
      <button className="btn btn-secondary" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function EmptyState({ title, children, action, onAction }) {
  return (
    <div className="state">
      <p className="state-title">{title}</p>
      {children && <p>{children}</p>}
      {action && (
        <button className="btn btn-primary" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

export function ScreenHeader({ title, sub }) {
  return (
    <header className="screen-header">
      <h1>{title}</h1>
      {sub && <p className="muted">{sub}</p>}
    </header>
  );
}
