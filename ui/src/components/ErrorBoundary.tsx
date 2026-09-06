import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Shown instead of the default card (e.g. a compact inline message). */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  /** Called when an error is caught — hook this up to logging if you have it. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors in the subtree below it.
 *
 * Without one, any uncaught error in any component unmounts the whole React
 * tree: the user gets a blank page with no explanation and no way back short of
 * a reload. Several views here fetch, parse and render untrusted content (repo
 * trees, diffs, assistant stream output), so a throw is a matter of when.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.props.onError?.(error, info);
    // Keep the console signal — swallowed errors are worse than noisy ones.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div
        role="alert"
        data-testid="error-boundary"
        className="max-w-xl mx-auto mt-16 p-6 rounded-xl border border-feedback-error-border bg-feedback-error-bg text-feedback-error-text space-y-3"
      >
        <h1 className="text-sm font-bold">Something went wrong</h1>
        <p className="text-xs opacity-90">
          This view crashed. Your data is safe — the rest of the app is still running.
        </p>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words opacity-80 bg-black/20 rounded p-3">
          {error.message || String(error)}
        </pre>
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={this.reset}
            data-testid="error-boundary-retry"
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-feedback-error-border hover:bg-black/10"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-feedback-error-border hover:bg-black/10"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
