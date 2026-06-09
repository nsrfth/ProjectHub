import { describe, expect, it } from 'vitest';
import {
  normaliseLdapHost,
  resolveLdapTransport,
} from '../../src/services/ldapService.js';

describe('ldapService helpers', () => {
  it('strips ldap:// from host', () => {
    expect(normaliseLdapHost('ldap://172.30.0.10')).toBe('172.30.0.10');
    expect(normaliseLdapHost('ldaps://dc.example.com')).toBe('dc.example.com');
  });

  it('resolves transport modes', () => {
    expect(resolveLdapTransport({ useTLS: false, port: 389 })).toBe('plain');
    expect(resolveLdapTransport({ useTLS: true, port: 389 })).toBe('starttls');
    expect(resolveLdapTransport({ useTLS: true, port: 636 })).toBe('ldaps');
    expect(resolveLdapTransport({ useTLS: true, port: null })).toBe('ldaps');
  });
});
