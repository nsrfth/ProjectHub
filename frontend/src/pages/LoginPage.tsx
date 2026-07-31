import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { motion } from 'framer-motion';
import { ArrowRight, Lock, Mail, ShieldCheck } from 'lucide-react';
import AetherFlowHero, { fadeUpVariants } from '@/components/ui/aether-flow-hero';
import { BrandMark, BrandWordmark } from '@/features/brand/BrandMark';
import { useAuth } from '@/features/auth/AuthContext';
import { useT } from '@/lib/i18n';

// Login is a two-step form when the user has 2FA enabled:
//   step 1 — email + password → may return a `pending2fa` token.
//   step 2 — render a TOTP / recovery-code input keyed by that pending token.
// The pending token lives only in this component's state; reloading the
// page drops it and the user starts over.
//
// v2.21: the form sits on the AetherFlowHero particle backdrop, which paints
// its own opaque dark canvas. That makes this the one route that ignores the
// active theme — every control here is styled for a dark surface directly
// instead of via the `bg-surface`/`text-text` tokens, which would be
// unreadable on it.

type Step =
  | { kind: 'credentials' }
  | { kind: 'twoFactor'; pendingToken: string };

// Testbed-only convenience: when the app is served by the local dev testbed
// (VITE_TESTBED=1, set only in testbed/docker-compose.local.yml), surface the
// seeded sample credentials on the login form with a one-click fill. The flag
// is never set in real deployments, so this stays invisible in production.
const TESTBED =
  import.meta.env.VITE_TESTBED === '1' || import.meta.env.VITE_TESTBED === 'true';
// The sample credentials are the seed defaults and nothing else — deliberately
// literals rather than the former VITE_TESTBED_EMAIL / VITE_TESTBED_PASSWORD
// reads, so no operator-supplied password can end up on the login screen.
//
// NOTE: this removes the *use*, not the exposure. Vite materialises the whole
// `import.meta.env` object into the bundle, so ANY VITE_-prefixed variable set
// at build time is served to every browser whether or not code reads it. That
// is a deployment rule, not something this file can enforce: never put a
// secret in a VITE_ variable. Nothing reads these two names any more, so there
// is no longer any reason to set them.
const SAMPLE_EMAIL = 'admin@taskhub.local';
const SAMPLE_PASSWORD = 'admin';

const FIELD_CLASS =
  'mt-1 w-full rounded-lg border border-white/10 bg-white/5 py-2.5 ps-10 pe-3 text-white ' +
  'placeholder:text-white/30 outline-none transition-colors focus:border-indigo-400/60 ' +
  'focus:bg-white/10 focus:ring-2 focus:ring-indigo-500/30';

const ICON_CLASS =
  'pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40';

const CARD_CLASS =
  'w-full max-w-sm space-y-4 rounded-2xl border border-white/10 bg-white/[0.06] p-6 ' +
  'shadow-2xl shadow-black/40 backdrop-blur-xl';

const SUBMIT_CLASS =
  'flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-500 py-2.5 font-medium ' +
  'text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-400 ' +
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-indigo-500';

export default function LoginPage(): JSX.Element {
  const { signIn, signInWith2fa } = useAuth();
  const nav = useNavigate();
  const t = useT();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submitCredentials(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await signIn(email, password);
      if (result.kind === 'pending2fa') {
        setStep({ kind: 'twoFactor', pendingToken: result.pendingToken });
      } else {
        nav('/dashboard');
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 503) {
        const msg = err.response?.data?.error?.message;
        setError(typeof msg === 'string' && msg.length ? msg : t('login.invalid'));
      } else {
        setError(t('login.invalid'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function submitTwoFactor(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (step.kind !== 'twoFactor') return;
    setError(null);
    setSubmitting(true);
    try {
      await signInWith2fa(step.pendingToken, code);
      nav('/dashboard');
    } catch {
      setError(t('login.twoFactorInvalid'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AetherFlowHero contentClassName="flex flex-col items-center gap-8 py-12">
      <motion.div
        custom={0}
        variants={fadeUpVariants}
        initial="hidden"
        animate="visible"
        className="space-y-4"
      >
        <div className="inline-flex items-center gap-2.5 text-2xl font-semibold text-white">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500 text-white">
            <BrandMark variant="inset" size={24} />
          </span>
          <BrandWordmark name={t('app.name')} />
        </div>
        <p className="mx-auto max-w-md text-sm text-white/50">{t('login.tagline')}</p>
      </motion.div>

      <motion.div
        custom={1}
        variants={fadeUpVariants}
        initial="hidden"
        animate="visible"
        className="flex w-full justify-center"
      >
        {step.kind === 'credentials' ? (
          <form onSubmit={submitCredentials} className={CARD_CLASS}>
            <div className="text-start">
              <h1 className="text-xl font-semibold text-white">{t('login.title')}</h1>
              <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-white/40">
                <ShieldCheck className="h-3.5 w-3.5 text-indigo-400" />
                {t('login.badge')}
              </p>
            </div>

            <label className="block text-start">
              <span className="text-sm font-medium text-white/70">{t('login.email')}</span>
              <span className="relative block">
                <Mail className={ICON_CLASS} />
                <input
                  type="text"
                  required
                  dir="ltr"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('login.placeholder.email')}
                  className={FIELD_CLASS}
                />
              </span>
            </label>

            <label className="block text-start">
              <span className="text-sm font-medium text-white/70">{t('login.password')}</span>
              <span className="relative block">
                <Lock className={ICON_CLASS} />
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={FIELD_CLASS}
                />
              </span>
            </label>

            {error && (
              <p
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-start text-sm text-red-300"
                role="alert"
              >
                {error}
              </p>
            )}

            <button type="submit" disabled={submitting} className={SUBMIT_CLASS}>
              {submitting ? t('login.submitting') : t('login.submit')}
              {!submitting && <ArrowRight className="h-4 w-4 rtl:-scale-x-100" />}
            </button>

            {TESTBED && (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-start text-xs text-amber-200">
                <div className="font-semibold">{t('login.testbed.title')}</div>
                <div className="mt-1 font-mono" dir="ltr">
                  {SAMPLE_EMAIL} / {SAMPLE_PASSWORD}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEmail(SAMPLE_EMAIL);
                    setPassword(SAMPLE_PASSWORD);
                  }}
                  className="mt-1 underline"
                >
                  {t('login.testbed.use')}
                </button>
              </div>
            )}

            {/* v1.30.11 (S-9): public self-registration removed.
                New accounts are admin-provisioned via Settings → Admin →
                New user (v1.26). The "no account → sign up" link is gone. */}
          </form>
        ) : (
          <form onSubmit={submitTwoFactor} className={CARD_CLASS}>
            <div className="text-start">
              <h1 className="text-xl font-semibold text-white">{t('login.twoFactorTitle')}</h1>
              <p className="mt-1 text-sm text-white/50">{t('login.twoFactorHelp')}</p>
            </div>

            <label className="block text-start">
              <span className="text-sm font-medium text-white/70">{t('login.twoFactorCode')}</span>
              <span className="relative block">
                <ShieldCheck className={ICON_CLASS} />
                <input
                  type="text"
                  required
                  dir="ltr"
                  autoComplete="one-time-code"
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={t('login.placeholder.twoFactorCode')}
                  className={`${FIELD_CLASS} font-mono`}
                />
              </span>
            </label>

            {error && (
              <p
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-start text-sm text-red-300"
                role="alert"
              >
                {error}
              </p>
            )}

            <button type="submit" disabled={submitting || !code} className={SUBMIT_CLASS}>
              {submitting ? t('login.twoFactorVerifying') : t('login.twoFactorVerify')}
            </button>

            <button
              type="button"
              onClick={() => {
                setStep({ kind: 'credentials' });
                setCode('');
                setError(null);
              }}
              className="w-full text-sm text-white/50 underline transition-colors hover:text-white/80"
            >
              {t('login.twoFactorBack')}
            </button>
          </form>
        )}
      </motion.div>
    </AetherFlowHero>
  );
}
