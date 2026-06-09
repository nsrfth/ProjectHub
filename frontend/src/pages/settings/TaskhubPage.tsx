import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import * as taskhubApi from '@/features/taskhub/api';

function errorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const msg = err.response?.data?.error?.message;
    if (typeof msg === 'string' && msg.length) return msg;
  }
  return fallback;
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export default function TaskhubPage(): JSX.Element {
  const qc = useQueryClient();
  const certRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const chainRef = useRef<HTMLInputElement>(null);

  const [port, setPort] = useState<number | ''>('');
  const [httpsEnabled, setHttpsEnabled] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { data: server, isLoading: serverLoading } = useQuery({
    queryKey: ['taskhub', 'server'],
    queryFn: taskhubApi.getTaskhubServer,
  });

  useEffect(() => {
    if (!server) return;
    setPort(server.port);
    setHttpsEnabled(server.httpsEnabled);
  }, [server]);

  const { data: ssl, isLoading: sslLoading } = useQuery({
    queryKey: ['taskhub', 'ssl'],
    queryFn: taskhubApi.getSslInfo,
  });

  const saveServerMut = useMutation({
    mutationFn: () =>
      taskhubApi.updateTaskhubServer({
        port: port === '' ? undefined : Number(port),
        httpsEnabled,
      }),
    onSuccess: (r) => {
      setMsg(r.restartRequired
        ? 'Server settings saved. Restart Caddy / Docker Compose for port and HTTPS changes to take effect.'
        : 'Server settings saved.');
      setErr(null);
      qc.invalidateQueries({ queryKey: ['taskhub'] });
    },
    onError: (e) => setErr(errorMessage(e, 'Could not save server settings')),
  });

  const uploadCertMut = useMutation({
    mutationFn: (pem: string) => taskhubApi.uploadSslCertificate(pem),
    onSuccess: () => {
      setMsg('Certificate uploaded. Restart Caddy to apply: docker compose restart caddy');
      setErr(null);
      qc.invalidateQueries({ queryKey: ['taskhub', 'ssl'] });
    },
    onError: (e) => setErr(errorMessage(e, 'Invalid certificate')),
  });

  const uploadKeyMut = useMutation({
    mutationFn: (pem: string) => taskhubApi.uploadSslPrivateKey(pem),
    onSuccess: () => {
      setMsg('Private key stored securely. Restart Caddy to apply HTTPS.');
      setErr(null);
      qc.invalidateQueries({ queryKey: ['taskhub', 'ssl'] });
    },
    onError: (e) => setErr(errorMessage(e, 'Invalid private key')),
  });

  const uploadChainMut = useMutation({
    mutationFn: (pem: string) => taskhubApi.uploadSslChain(pem),
    onSuccess: () => {
      setMsg('Certificate chain uploaded.');
      setErr(null);
      qc.invalidateQueries({ queryKey: ['taskhub', 'ssl'] });
    },
    onError: (e) => setErr(errorMessage(e, 'Invalid chain')),
  });

  async function onFile(
    ref: React.RefObject<HTMLInputElement>,
    upload: (pem: string) => void,
  ): Promise<void> {
    const file = ref.current?.files?.[0];
    if (!file) return;
    setMsg(null);
    setErr(null);
    const pem = await readFile(file);
    upload(pem);
    ref.current!.value = '';
  }

  function submitServer(e: FormEvent): void {
    e.preventDefault();
    saveServerMut.mutate();
  }

  const sslWarning =
    ssl?.status === 'expired'
      ? 'Certificate has expired.'
      : ssl?.status === 'expiring_soon'
        ? `Certificate expires in ${ssl.daysUntilExpiration} day(s).`
        : !ssl?.httpsEnabled
          ? 'HTTPS is disabled in configuration.'
          : null;

  return (
    <section className="space-y-8">
      <header>
        <h2 className="text-lg font-semibold mb-1">TaskHub server</h2>
        <p className="text-sm text-slate-500">
          Application server port and TLS certificate management. Changes to the listening port
          require a container restart.
        </p>
      </header>

      {msg && <p className="text-sm text-emerald-700 dark:text-emerald-400">{msg}</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}

      <form onSubmit={submitServer} className="border rounded p-4 space-y-3">
        <h3 className="font-medium">Server port</h3>
        {serverLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {server && (
          <>
            <p className="text-xs text-slate-500">
              Active port (runtime): <strong>{server.activePort}</strong>
              {server.updatedAt && (
                <> · Last config update: {new Date(server.updatedAt).toLocaleString()}</>
              )}
            </p>
            <label className="block text-sm">
              <span className="text-slate-600">Configured port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value ? Number(e.target.value) : '')}
                className="mt-1 block w-32 rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-700 px-2 py-1"
              />
            </label>
            {Number(port) > 0 && Number(port) < 1024 && (
              <p className="text-xs text-amber-700">
                Ports below 1024 are privileged — ensure Docker maps them correctly.
              </p>
            )}
            <p className="text-xs text-slate-500">
              Changing the server port requires application restart to take effect.
            </p>
            <button
              type="submit"
              disabled={saveServerMut.isPending}
              className="text-sm bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded px-3 py-1.5 disabled:opacity-50"
            >
              Save port
            </button>
          </>
        )}
      </form>

      <div className="border rounded p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h3 className="font-medium">HTTPS / SSL</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={httpsEnabled}
              onChange={(e) => {
                const enabled = e.target.checked;
                setHttpsEnabled(enabled);
                taskhubApi.updateTaskhubServer({ httpsEnabled: enabled, port: port === '' ? undefined : Number(port) })
                  .then((r) => {
                    setMsg(r.restartRequired ? 'HTTPS setting saved. Restart Caddy to apply.' : 'HTTPS setting saved.');
                    qc.invalidateQueries({ queryKey: ['taskhub'] });
                  })
                  .catch((ex) => setErr(errorMessage(ex, 'Could not update HTTPS')));
              }}
            />
            Enable HTTPS
          </label>
        </div>

        {sslWarning && (
          <p className="text-xs text-amber-800 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 rounded p-2">
            {sslWarning}
          </p>
        )}

        {sslLoading && <p className="text-sm text-slate-500">Loading certificate info…</p>}
        {ssl && (
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <div><dt className="text-slate-500 inline">Status: </dt><dd className="inline capitalize">{ssl.status.replace('_', ' ')}</dd></div>
            <div><dt className="text-slate-500 inline">CN: </dt><dd className="inline">{ssl.commonName ?? '—'}</dd></div>
            <div><dt className="text-slate-500 inline">Issuer: </dt><dd className="inline">{ssl.issuer ?? '—'}</dd></div>
            <div><dt className="text-slate-500 inline">Valid from: </dt><dd className="inline">{ssl.validFrom ?? '—'}</dd></div>
            <div><dt className="text-slate-500 inline">Expires: </dt><dd className="inline">{ssl.validTo ?? '—'}</dd></div>
            <div><dt className="text-slate-500 inline">Days left: </dt><dd className="inline">{ssl.daysUntilExpiration ?? '—'}</dd></div>
            <div><dt className="text-slate-500 inline">Certificate: </dt><dd className="inline">{ssl.hasCertificate ? 'Uploaded' : 'Missing'}</dd></div>
            <div><dt className="text-slate-500 inline">Private key: </dt><dd className="inline">{ssl.hasPrivateKey ? 'Stored (hidden)' : 'Missing'}</dd></div>
          </dl>
        )}

        <div className="flex flex-wrap gap-2">
          <input ref={certRef} type="file" accept=".pem,.crt,.cer,.txt" className="hidden" onChange={() => onFile(certRef, (p) => uploadCertMut.mutate(p))} />
          <input ref={keyRef} type="file" accept=".pem,.key,.txt" className="hidden" onChange={() => onFile(keyRef, (p) => uploadKeyMut.mutate(p))} />
          <input ref={chainRef} type="file" accept=".pem,.crt,.cer,.txt" className="hidden" onChange={() => onFile(chainRef, (p) => uploadChainMut.mutate(p))} />
          <button type="button" onClick={() => certRef.current?.click()} className="text-xs border rounded px-2 py-1">Upload certificate</button>
          <button type="button" onClick={() => keyRef.current?.click()} className="text-xs border rounded px-2 py-1">Upload private key</button>
          <button type="button" onClick={() => chainRef.current?.click()} className="text-xs border rounded px-2 py-1">Upload chain (optional)</button>
        </div>
        <p className="text-xs text-slate-500">
          Certificates are stored on the server volume shared with Caddy. Private keys are never
          shown after upload. Restart Caddy after uploading cert + key.
        </p>
      </div>
    </section>
  );
}
