import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import axios from 'axios';
import { useAuth } from '@/features/auth/AuthContext';
import { useT } from '@/lib/i18n';
import {
  changeOwnPassword,
  regenerateRecoveryCodes,
  twoFactorConfirm,
  twoFactorDisable,
  twoFactorSetup,
  type TwoFactorSetup,
} from '@/features/auth/api';

// Settings → Security. Phase 2C surfaces TOTP enrolment + disable + recovery
// code regeneration. Future phases (password rotation policy, sign-in log
// links) can land here without restructuring the layout.

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

export default function SecurityPage(): JSX.Element {
  const { user, patchUser } = useAuth();
  const t = useT();

  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold mb-1">Security</h2>
        <p className="text-sm text-slate-500">
          Two-factor authentication and account-level credentials.
        </p>
      </header>

      {/* v1.32.0: change own password. Hidden for directory-owned accounts —
          their password lives in the directory and the backend would 403. */}
      <div className="border rounded p-4">
        <h3 className="font-medium mb-1">{t('security.password.title')}</h3>
        {user?.authSource === 'LDAP' && (
          <p className="text-xs text-slate-500 mb-2">LDAP account — sign in with your directory password.</p>
        )}
        {user?.authSource === 'SCIM' && (
          <p className="text-xs text-slate-500 mb-2">Provisioned account — password is managed by your identity provider.</p>
        )}
        {user?.directoryId ? (
          <p className="text-sm text-slate-600">
            {t('security.password.directoryOwned')}
          </p>
        ) : (
          <ChangePasswordPanel />
        )}
      </div>

      <div className="border rounded p-4">
        <h3 className="font-medium mb-1">Two-factor authentication</h3>
        <p className="text-sm text-slate-600 mb-3">
          Add a 6-digit code from an authenticator app on top of your password.
          Recommended.
        </p>
        {user?.totpEnabled
          ? <DisablePanel onDisabled={() => patchUser({ totpEnabled: false })} />
          : <EnrollPanel onEnrolled={() => patchUser({ totpEnabled: true })} />}
      </div>
    </section>
  );
}

// v1.32.0: change-own-password form. On success the backend has revoked
// every refresh-token row for this user — including the cookie this tab is
// using — so we explicitly signOut and bounce to /login. The current access
// token would otherwise stay valid for ~15 minutes and then 401 on the next
// /refresh; signing out immediately is the predictable path.
function ChangePasswordPanel(): JSX.Element {
  const { signOut } = useAuth();
  const nav = useNavigate();
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      changeOwnPassword({ currentPassword: current, newPassword: next }),
    onSuccess: async () => {
      await signOut().catch(() => undefined);
      nav('/login', { replace: true });
    },
    onError: (err) => setError(errorMessage(err, t('security.password.error'))),
  });

  function submit(e: FormEvent): void {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError(t('security.password.mismatch'));
      return;
    }
    mut.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-3 max-w-sm">
      <p className="text-sm text-slate-600">{t('security.password.intro')}</p>
      <Field
        label={t('security.password.current')}
        value={current}
        onChange={setCurrent}
        autoComplete="current-password"
      />
      <Field
        label={t('security.password.new')}
        value={next}
        onChange={setNext}
        autoComplete="new-password"
      />
      <Field
        label={t('security.password.confirm')}
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
      />
      <p className="text-xs text-slate-500">{t('security.password.policyHint')}</p>
      {error && <p className="text-red-600 text-xs">{error}</p>}
      <button
        type="submit"
        disabled={mut.isPending || !current || !next || !confirm}
        className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50"
      >
        {mut.isPending ? t('security.password.submitting') : t('security.password.submit')}
      </button>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}): JSX.Element {
  return (
    <label className="block">
      <span className="text-xs font-medium">{label}</span>
      <input
        type="password"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="mt-1 w-full rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-2 py-1 text-sm"
      />
    </label>
  );
}

// ── Enrol new ────────────────────────────────────────────────────────────
function EnrollPanel({ onEnrolled }: { onEnrolled: () => void }): JSX.Element {
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setupMut = useMutation({
    mutationFn: twoFactorSetup,
    onSuccess: (data) => {
      setSetup(data);
      setError(null);
    },
    onError: (err) => setError(errorMessage(err, 'Could not start enrolment')),
  });

  const confirmMut = useMutation({
    mutationFn: (input: { secret: string; code: string }) => twoFactorConfirm(input),
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      onEnrolled();
    },
    onError: (err) => setError(errorMessage(err, 'Invalid code')),
  });

  // Just-finished — show the one-time recovery codes.
  if (recoveryCodes) {
    return <RecoveryCodeReveal codes={recoveryCodes} title="2FA enabled" />;
  }

  // Step 1 — start.
  if (!setup) {
    return (
      <button
        type="button"
        onClick={() => setupMut.mutate()}
        disabled={setupMut.isPending}
        className="bg-slate-900 text-white rounded px-3 py-1 text-sm font-medium"
      >
        {setupMut.isPending ? 'Setting up…' : 'Enable 2FA'}
      </button>
    );
  }

  // Step 2 — scan + confirm.
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        confirmMut.mutate({ secret: setup.secret, code });
      }}
      className="space-y-3 text-sm"
    >
      <ol className="list-decimal pl-5 text-slate-700 space-y-1">
        <li>
          Scan the QR code with your authenticator app (Google Authenticator,
          1Password, Bitwarden, Authy, …).
        </li>
        <li>Or paste the manual key into the app.</li>
        <li>Type the 6-digit code the app shows.</li>
      </ol>
      <div className="flex flex-wrap gap-4 items-start">
        <img src={setup.qrDataUrl} alt="2FA QR code" className="border rounded" />
        <div className="text-xs">
          <p className="text-slate-500 mb-1">Manual key</p>
          <code className="bg-slate-100 rounded px-2 py-1 block break-all">{setup.secret}</code>
        </div>
      </div>
      <label className="block">
        <span className="text-xs font-medium">6-digit code</span>
        <input
          required
          autoFocus
          inputMode="numeric"
          pattern="\d{6}"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="mt-1 border rounded px-2 py-1 w-32 font-mono"
        />
      </label>
      {error && <p className="text-red-600 text-xs">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={confirmMut.isPending || code.length !== 6}
          className="bg-slate-900 text-white rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
        >
          {confirmMut.isPending ? 'Verifying…' : 'Confirm + finish'}
        </button>
        <button
          type="button"
          onClick={() => {
            setSetup(null);
            setCode('');
            setError(null);
          }}
          className="text-sm underline"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Disable + regenerate ─────────────────────────────────────────────────
function DisablePanel({ onDisabled }: { onDisabled: () => void }): JSX.Element {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  const disableMut = useMutation({
    mutationFn: (c: string) => twoFactorDisable(c),
    onSuccess: () => {
      onDisabled();
      setCode('');
      setError(null);
    },
    onError: (err) => setError(errorMessage(err, 'Invalid code')),
  });

  const regenMut = useMutation({
    mutationFn: regenerateRecoveryCodes,
    onSuccess: (res) => setNewCodes(res.recoveryCodes),
    onError: (err) => setError(errorMessage(err, 'Could not regenerate codes')),
  });

  if (newCodes) {
    return <RecoveryCodeReveal codes={newCodes} title="New recovery codes" />;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-emerald-700">2FA is enabled on this account.</p>

      <div>
        <p className="text-xs font-medium text-slate-700 mb-1">Disable</p>
        <p className="text-xs text-slate-500 mb-2">
          Removing 2FA reduces account security. Confirm with a current 6-digit
          code or one of your recovery codes.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            disableMut.mutate(code);
          }}
          className="flex flex-wrap gap-2 items-end"
        >
          <input
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456 or xxxx-xxxx"
            className="border rounded px-2 py-1 text-sm font-mono w-48"
          />
          <button
            type="submit"
            disabled={disableMut.isPending || !code}
            className="bg-red-600 text-white rounded px-3 py-1 text-sm font-medium disabled:opacity-50"
          >
            {disableMut.isPending ? 'Disabling…' : 'Disable 2FA'}
          </button>
        </form>
      </div>

      <div className="border-t pt-3">
        <p className="text-xs font-medium text-slate-700 mb-1">Recovery codes</p>
        <p className="text-xs text-slate-500 mb-2">
          Regenerating produces a fresh set and invalidates the previous one
          immediately.
        </p>
        <button
          type="button"
          onClick={() => regenMut.mutate()}
          disabled={regenMut.isPending}
          className="text-sm underline"
        >
          {regenMut.isPending ? 'Generating…' : 'Regenerate recovery codes'}
        </button>
      </div>

      {error && <p className="text-red-600 text-xs">{error}</p>}
    </div>
  );
}

// ── One-shot recovery-code reveal ────────────────────────────────────────
function RecoveryCodeReveal({ codes, title }: { codes: string[]; title: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const joined = codes.join('\n');
  return (
    <div className="space-y-3">
      <h4 className="font-medium text-emerald-700">{title}</h4>
      <p className="text-xs text-slate-600">
        Save these recovery codes somewhere safe. Each can be used once if you
        lose access to your authenticator. This is the only time they'll be
        shown.
      </p>
      <pre className="bg-slate-100 rounded p-3 text-xs font-mono whitespace-pre">
        {joined}
      </pre>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(joined).catch(() => undefined);
          setCopied(true);
        }}
        className="text-xs underline"
      >
        {copied ? 'Copied' : 'Copy all'}
      </button>
    </div>
  );
}
