import { describe, expect, it } from 'vitest';
import { renderTemplate, DEFAULT_TEMPLATES, toE164 } from '@vibe1099/core';
import { redactPii } from '@vibe1099/core/logger';

describe('message templates', () => {
  it('substitutes {{vars}} and leaves unknown vars empty', () => {
    expect(renderTemplate('Hi {{name}}, see {{link}} ({{missing}})', { name: 'A', link: 'x' })).toBe('Hi A, see x ()');
  });
  it('ships every default template with the vars it references', () => {
    for (const t of DEFAULT_TEMPLATES) {
      const referenced = [...t.body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
      for (const v of referenced) expect(t.vars, `${t.key} missing var ${v}`).toContain(v);
    }
  });
  it('no template ever interpolates a TIN variable', () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(t.vars.join(',')).not.toMatch(/tin/i);
    }
  });
});

describe('E.164 normalization', () => {
  it('normalizes US numbers', () => {
    expect(toE164('(816) 555-0123')).toBe('+18165550123');
    expect(toE164('1-816-555-0123')).toBe('+18165550123');
    expect(toE164('+18165550123')).toBe('+18165550123');
  });
  it('rejects invalid', () => {
    expect(() => toE164('12345')).toThrow();
  });
});

describe('PII redaction (never log TINs)', () => {
  it('scrubs TIN-shaped strings from log messages', () => {
    expect(redactPii('ssn 400-11-1222 ein 43-1234567 raw 400111222')).toBe(
      'ssn [TIN-REDACTED] ein [TIN-REDACTED] raw [TIN-REDACTED]',
    );
  });
  it('scrubs spaced SSNs too', () => {
    expect(redactPii('ssn 400 11 1222 here')).toBe('ssn [TIN-REDACTED] here');
  });
});
