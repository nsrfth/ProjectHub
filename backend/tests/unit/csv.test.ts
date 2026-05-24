import { describe, expect, it } from 'vitest';
import { toCsv } from '../../src/lib/csv.js';

// CSV serializer is small, pure, and security-relevant (CSV-injection
// neutralisation). Exhaustive coverage on the corner cases is cheap.

describe('toCsv', () => {
  it('writes header + rows with the BOM prefix and CRLF line endings', () => {
    const out = toCsv(
      [{ a: 1, b: 'x' }],
      [
        { header: 'a', value: (r) => r.a },
        { header: 'b', value: (r) => r.b },
      ],
    );
    expect(out).toBe('﻿a,b\r\n1,x\r\n');
  });

  it('quotes fields with commas, quotes, or newlines and doubles inner quotes', () => {
    const out = toCsv(
      [{ s: 'hello, "world"\nnext' }],
      [{ header: 's', value: (r) => r.s }],
    );
    expect(out).toBe('﻿s\r\n"hello, ""world""\nnext"\r\n');
  });

  it('renders Dates as ISO strings and null/undefined as empty', () => {
    const out = toCsv(
      [{ d: new Date('2026-05-24T10:00:00Z'), x: null, y: undefined }],
      [
        { header: 'd', value: (r) => r.d },
        { header: 'x', value: (r) => r.x as null },
        { header: 'y', value: (r) => r.y as undefined },
      ],
    );
    expect(out).toBe('﻿d,x,y\r\n2026-05-24T10:00:00.000Z,,\r\n');
  });

  it('neutralises CSV injection by prefixing values that begin with =,+,-,@', () => {
    const out = toCsv(
      [
        { v: '=1+1' },
        { v: '+cmd' },
        { v: '-2' },
        { v: '@evil' },
      ],
      [{ header: 'v', value: (r) => r.v }],
    );
    // The leading apostrophe neutralises Excel/Sheets formula parsing.
    expect(out).toBe("﻿v\r\n'=1+1\r\n'+cmd\r\n'-2\r\n'@evil\r\n");
  });

  it('emits header-only output for an empty row set', () => {
    const out = toCsv([], [{ header: 'a', value: () => '' }]);
    expect(out).toBe('﻿a\r\n');
  });
});
