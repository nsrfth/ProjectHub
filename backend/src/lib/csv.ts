// Minimal CSV serializer. RFC 4180 — fields are double-quoted; embedded
// quotes are doubled; CRLF terminates each record. No external dep needed:
// the report shapes are small and predictable.

type Primitive = string | number | boolean | Date | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => Primitive;
}

function escapeField(v: Primitive): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else s = v;
  // Quote whenever the field contains a quote, comma, or any line break, OR
  // starts with chars Excel/Sheets interpret as a formula (CSV injection).
  // The leading-character defence prefixes a single quote to neutralise.
  const needsQuoting = /[",\r\n]/.test(s);
  if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (!needsQuoting) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const header = columns.map((c) => escapeField(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => escapeField(c.value(r))).join(',')).join('\r\n');
  // BOM so Excel opens UTF-8 CSV with the right encoding by default.
  const prefix = '﻿';
  return prefix + header + (body.length ? '\r\n' + body : '') + '\r\n';
}
