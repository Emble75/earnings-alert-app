import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './kit';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Structured, secret-free breadcrumb for debugging.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'render error',
        err: error.message,
        component: info.componentStack?.split('\n')[1]?.trim(),
      }),
    );
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="container" style={{ paddingBlock: 'var(--s-8)' }} role="alert">
        <div className="eyebrow lime">Red card</div>
        <h1 style={{ fontSize: 'var(--fs-3xl)', margin: 'var(--s-3) 0' }}>
          Something broke on the pitch
        </h1>
        <p style={{ color: 'var(--chalk-dim)', maxWidth: '40ch' }}>
          That screen hit an unexpected error. Your room seat is saved — reloading usually gets you
          straight back in.
        </p>
        <div className="row" style={{ marginTop: 'var(--s-5)' }}>
          <Button onClick={() => location.reload()}>Reload</Button>
          <Button variant="secondary" onClick={() => (location.href = '/')}>
            Home
          </Button>
        </div>
      </div>
    );
  }
}
