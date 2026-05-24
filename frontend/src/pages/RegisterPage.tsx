import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';

export default function RegisterPage(): JSX.Element {
  const { signUp } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signUp(email, name, password);
      nav('/dashboard');
    } catch (err: any) {
      const code = err?.response?.data?.error?.code;
      setError(
        code === 'CONFLICT'
          ? 'That email is already registered.'
          : code === 'VALIDATION_ERROR'
            ? 'Please use a stronger password (12+ chars, letters and digits).'
            : 'Could not create account.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm bg-white dark:bg-slate-800 shadow rounded-lg p-6 space-y-4"
      >
        <h1 className="text-2xl font-semibold">Create account</h1>

        <label className="block">
          <span className="text-sm font-medium">Name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-3 py-2 border"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-3 py-2 border"
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <input
            type="password"
            required
            autoComplete="new-password"
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border-slate-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 px-3 py-2 border"
          />
          <span className="block text-xs text-slate-500 dark:text-slate-400 mt-1">
            At least 12 characters, must include letters and digits.
          </span>
        </label>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded py-2 font-medium disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Create account'}
        </button>

        <p className="text-sm text-slate-600 dark:text-slate-300">
          Already have an account?{' '}
          <Link to="/login" className="underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
