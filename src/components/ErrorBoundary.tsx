// ============================================================================
// ErrorBoundary — top-level render guard.
//
// A thrown error in ANY view (e.g. a corrupt data row hitting an unguarded
// `.toFixed`) used to take down the whole app: blank screen, no way back.
// This boundary converts that into a per-view error card with a Retry —
// "one tab broken + recovery" instead of "whole shell dead".
// ============================================================================

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Label shown in the error card (e.g. the tab name). */
  context?: string;
}

interface State {
  error: Error | null;
  /** Bumped on Retry to force children to remount fresh. */
  attempt: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Log for diagnosis; the card below is the user-facing recovery path.
    console.error('[OmniFlow] render error', this.props.context ?? '', error);
  }

  private reset = () => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div
          className="card"
          style={{
            margin: '12px',
            border: '1px solid var(--bad, #dc2626)',
            background: 'color-mix(in srgb, var(--bad, #dc2626) 8%, transparent)',
          }}
          role="alert"
        >
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>
            {this.props.context ? `Something broke in the ${this.props.context} tab.` : 'Something broke here.'}
          </h3>
          <p className="muted small" style={{ margin: '0 0 10px' }}>
            The rest of your data is safe and still encrypted. Retry usually fixes it; if not,
            switch tabs and come back — your numbers have not been lost.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" onClick={this.reset}>Retry</button>
            <code className="muted small" style={{ overflowWrap: 'anywhere' }}>
              {error.message}
            </code>
          </div>
        </div>
      );
    }
    // `attempt` in the key remounts children on Retry so stale internal
    // state (an in-flight fetch, a half-edited form) starts clean.
    return <div key={this.state.attempt}>{this.props.children}</div>;
  }
}
