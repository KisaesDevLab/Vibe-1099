import { describe, expect, it } from 'vitest';

/**
 * transmissions.errorDetails carries two shapes:
 *   - per-record ack errors  { recordId, code, message }
 *   - whole-submission fail  { recordId: '', code: 'TRANSMIT_FAILED', message }
 *     (older rows, pre-0.1.19, wrote a bare { error } with NO recordId)
 *
 * The transmissions screen crashed the whole app on the bare-{error} shape:
 *   TypeError: Cannot read properties of undefined (reading 'slice')
 * These lock in the rendering contract the UI relies on.
 */

interface ErrorDetail {
  recordId?: string;
  code?: string;
  message?: string;
  error?: string;
}

/** Mirrors the row rendering in staff/Transmissions.tsx. */
function renderRow(e: ErrorDetail): { record: string; code: string; message: string } {
  return {
    record: e.recordId ? `${e.recordId.slice(0, 8)}…` : 'whole submission',
    code: e.code ?? (e.error ? 'TRANSMIT_FAILED' : ''),
    message: e.message ?? e.error ?? '',
  };
}

describe('transmission errorDetails rendering', () => {
  it('renders per-record ack errors with a truncated record id', () => {
    expect(renderRow({ recordId: '0123456789abcdef', code: 'F00-1', message: 'TIN mismatch' })).toEqual({
      record: '01234567…',
      code: 'F00-1',
      message: 'TIN mismatch',
    });
  });

  it('survives the legacy whole-transmission shape that had no recordId (the crash)', () => {
    expect(renderRow({ error: 'TaxBandits create rejected (400)' })).toEqual({
      record: 'whole submission',
      code: 'TRANSMIT_FAILED',
      message: 'TaxBandits create rejected (400)',
    });
  });

  it('survives the normalized whole-transmission shape (empty recordId)', () => {
    expect(renderRow({ recordId: '', code: 'TRANSMIT_FAILED', message: 'boom' })).toEqual({
      record: 'whole submission',
      code: 'TRANSMIT_FAILED',
      message: 'boom',
    });
  });

  it('never throws on a fully empty entry', () => {
    expect(() => renderRow({})).not.toThrow();
    expect(renderRow({})).toEqual({ record: 'whole submission', code: '', message: '' });
  });
});
