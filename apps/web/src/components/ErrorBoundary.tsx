/**
 * Route-level error boundary. A render fault in one screen must never blank the
 * whole appliance mid-season: show what broke, keep the shell navigable, and
 * let staff retry or move on. Also catches router errors (404s, loader throws).
 */
import { Component, type ReactNode } from 'react';
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';

function describe(error: unknown): { title: string; detail: string } {
  if (isRouteErrorResponse(error)) {
    return { title: `${error.status} ${error.statusText}`, detail: typeof error.data === 'string' ? error.data : '' };
  }
  if (error instanceof Error) return { title: 'This screen hit an error', detail: `${error.message}\n\n${error.stack ?? ''}` };
  return { title: 'This screen hit an error', detail: String(error) };
}

function ErrorPanel({ error, onReset }: { error: unknown; onReset?: () => void }): JSX.Element {
  const { title, detail } = describe(error);
  return (
    <div className="panel" style={{ margin: 16 }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p className="muted">
        The rest of the app is still working — use the menu to go elsewhere, or reload this screen. If it keeps happening, send this
        message to your administrator.
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <button onClick={() => (onReset ? onReset() : window.location.reload())}>Reload this screen</button>
        <button className="secondary" onClick={() => { window.location.href = '/'; }}>Go to dashboard</button>
      </div>
      {detail && (
        <details>
          <summary className="muted" style={{ cursor: 'pointer' }}>Technical details</summary>
          <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }}>{detail}</pre>
        </details>
      )}
    </div>
  );
}

/** Router errorElement (route/loader errors + render faults inside the route). */
export function RouteErrorBoundary(): JSX.Element {
  const error = useRouteError();
  const navigate = useNavigate();
  return <ErrorPanel error={error} onReset={() => navigate(0)} />;
}

/**
 * Class boundary for render faults in nested trees the router does not own
 * (the public portals render outside the staff shell).
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  override render(): ReactNode {
    if (this.state.error) return <ErrorPanel error={this.state.error} onReset={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
