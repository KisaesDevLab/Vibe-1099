/**
 * App-wide dialog + toast provider — replaces native alert()/confirm()/prompt()
 * (which break the polished panel system) with consistent in-app UI, plus a
 * transient toast stack for action results.
 *
 * Usage: const d = useDialogs();  await d.confirm('…');  d.toast('Saved', 'success');
 */
import { createContext, ReactNode, useCallback, useContext, useState } from 'react';
import { Modal } from './Modal';

type Severity = 'info' | 'success' | 'warning' | 'error';
interface Toast { id: number; message: string; severity: Severity }

interface DialogRequest {
  kind: 'alert' | 'confirm' | 'prompt' | 'reveal';
  title: string;
  message?: string;
  defaultValue?: string;
  revealValue?: string;
  danger?: boolean;
  resolve: (v: unknown) => void;
}

interface DialogApi {
  alert: (message: string, title?: string) => Promise<void>;
  confirm: (message: string, opts?: { title?: string; danger?: boolean }) => Promise<boolean>;
  prompt: (message: string, opts?: { title?: string; defaultValue?: string }) => Promise<string | null>;
  reveal: (title: string, value: string) => Promise<void>;
  toast: (message: string, severity?: Severity) => void;
}

const Ctx = createContext<DialogApi | null>(null);
export function useDialogs(): DialogApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDialogs must be used within DialogProvider');
  return v;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<DialogRequest | null>(null);
  const [input, setInput] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, severity: Severity = 'info') => {
    const id = Date.now() + Math.floor(performance.now());
    setToasts((t) => [...t, { id, message, severity }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const open = useCallback((r: Omit<DialogRequest, 'resolve'>) =>
    new Promise<unknown>((resolve) => { setInput(r.defaultValue ?? ''); setReq({ ...r, resolve }); }), []);

  const api: DialogApi = {
    alert: (message, title = 'Notice') => open({ kind: 'alert', title, message }).then(() => undefined),
    confirm: (message, opts) => open({ kind: 'confirm', title: opts?.title ?? 'Please confirm', message, danger: opts?.danger }).then((v) => !!v),
    prompt: (message, opts) => open({ kind: 'prompt', title: opts?.title ?? 'Enter a value', message, defaultValue: opts?.defaultValue }).then((v) => (v as string | null)),
    reveal: (title, value) => open({ kind: 'reveal', title, revealValue: value }).then(() => undefined),
    toast,
  };

  const close = (value: unknown) => { req?.resolve(value); setReq(null); };

  return (
    <Ctx.Provider value={api}>
      {children}
      {req && (
        <Modal title={req.title} onClose={() => close(req.kind === 'confirm' ? false : req.kind === 'prompt' ? null : undefined)} width={req.kind === 'reveal' ? 420 : 480}>
          {req.message && <p style={{ marginTop: 0 }}>{req.message}</p>}
          {req.kind === 'reveal' && (
            <div className="row" style={{ gap: 8 }}>
              <input className="mono" readOnly value={req.revealValue} style={{ fontSize: 16 }} onFocus={(e) => e.target.select()} />
              <button className="secondary" onClick={() => { void navigator.clipboard?.writeText(req.revealValue ?? ''); toast('Copied', 'success'); }}>Copy</button>
            </div>
          )}
          {req.kind === 'prompt' && (
            <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && close(input)} />
          )}
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14, gap: 8 }}>
            {(req.kind === 'confirm' || req.kind === 'prompt') && <button className="secondary" onClick={() => close(req.kind === 'confirm' ? false : null)}>Cancel</button>}
            <button className={req.danger ? 'danger' : ''} onClick={() => close(req.kind === 'prompt' ? input : req.kind === 'confirm' ? true : undefined)}>
              {req.kind === 'confirm' ? (req.danger ? 'Confirm' : 'OK') : req.kind === 'prompt' ? 'OK' : 'Close'}
            </button>
          </div>
        </Modal>
      )}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.severity}`} onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}>
            {t.severity === 'success' ? '✅' : t.severity === 'error' ? '⛔' : t.severity === 'warning' ? '⚠️' : 'ℹ️'} {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
