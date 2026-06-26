import axios from 'axios';
import { useT } from '@/lib/i18n';

export function isModuleDisabled(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.data?.error?.code === 'module_disabled';
}

export function ModuleDisabledBanner(): JSX.Element {
  const t = useT();
  return (
    <div className="rounded border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
      {t('module.disabled')}
    </div>
  );
}
