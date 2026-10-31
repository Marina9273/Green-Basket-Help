import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';

type RequestStatus = 'new' | 'contacted' | 'in_progress' | 'completed' | 'cancelled';
type ServiceType = 'housing' | 'assistance';

interface RequestRow {
  id: string;
  service_type: ServiceType;
  status: RequestStatus;
  customer_name: string;
  contact_method: 'telegram' | 'whatsapp' | 'zalo' | 'email';
  contact_value: string;
  preferred_language: string;
  language_other: string | null;
  stay_duration: string;
  stay_other: string | null;
  description: string;
  details: Record<string, unknown>;
  locale: 'en' | 'ru';
  indicative_price_vnd: number | null;
  price_kind: string;
  consent_at: string;
  consent_version: string;
  admin_note: string | null;
  created_at: string;
  updated_at: string;
  total_count: number;
}

const pageSize = 25;
const statuses: RequestStatus[] = ['new', 'contacted', 'in_progress', 'completed', 'cancelled'];
const allowedNext: Record<RequestStatus, RequestStatus[]> = {
  new: ['contacted', 'cancelled'],
  contacted: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const formatDate = (value: string, locale: 'en' | 'ru') =>
  new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value));

const contactUrl = (row: RequestRow) => {
  if (row.contact_method === 'email') return `mailto:${row.contact_value}`;
  if (row.contact_method === 'telegram') return `https://t.me/${row.contact_value.replace(/^@/, '')}`;
  if (row.contact_method === 'whatsapp') return `https://wa.me/${row.contact_value.replace(/\D/g, '')}`;
  return null;
};

const AdminRequests = () => {
  const { t, i18n } = useTranslation('help');
  const locale: 'en' | 'ru' = i18n.resolvedLanguage?.startsWith('ru') ? 'ru' : 'en';
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [access, setAccess] = useState<'loading' | 'allowed' | 'denied' | 'signed_out'>('loading');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState(false);
  const [loginPending, setLoginPending] = useState(false);
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [page, setPage] = useState(0);
  const [serviceFilter, setServiceFilter] = useState<'all' | ServiceType>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | RequestStatus>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<RequestStatus>('new');
  const [draftNote, setDraftNote] = useState('');
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authReady) return;
    if (!session) {
      setAccess('signed_out');
      return;
    }
    let active = true;
    setAccess('loading');
    void supabase.rpc('is_concierge_admin').then(({ data, error }) => {
      if (active) setAccess(!error && data === true ? 'allowed' : 'denied');
    });
    return () => { active = false; };
  }, [authReady, session]);

  useEffect(() => {
    if (access !== 'allowed') return;
    let active = true;
    setListLoading(true);
    setListError(false);
    void supabase.rpc('list_help_service_requests', {
      p_page: page,
      p_page_size: pageSize,
      p_service_type: serviceFilter === 'all' ? null : serviceFilter,
      p_status: statusFilter === 'all' ? null : statusFilter,
    }).then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setListError(true);
        setRows([]);
      } else {
        setRows((data ?? []) as unknown as RequestRow[]);
      }
      setListLoading(false);
    });
    return () => { active = false; };
  }, [access, page, serviceFilter, statusFilter, refreshKey]);

  const selected = useMemo(
    () => rows.find(row => row.id === selectedId) ?? rows[0] ?? null,
    [rows, selectedId],
  );

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setDraftStatus(selected.status);
    setDraftNote(selected.admin_note ?? '');
    setSaveError('');
    setSaved(false);
  }, [selected]);

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginError(false);
    setLoginPending(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoginPending(false);
    if (error) setLoginError(true);
  };

  const saveRequest = async () => {
    if (!selected) return;
    setSavePending(true);
    setSaved(false);
    setSaveError('');
    const { error } = await supabase.rpc('update_help_service_request', {
      p_request_id: selected.id,
      p_expected_updated_at: selected.updated_at,
      p_status: draftStatus,
      p_admin_note: draftNote,
    });
    setSavePending(false);
    if (error) {
      setSaveError(error.message.includes('conflict') ? t('admin.conflict') : t('admin.error'));
      return;
    }
    setSaved(true);
    setRefreshKey(value => value + 1);
  };

  const totalCount = rows[0]?.total_count ?? 0;
  const pages = Math.max(1, Math.ceil(totalCount / pageSize));
  const selectedDetails = selected?.details && typeof selected.details === 'object' ? selected.details : {};

  if (!authReady || access === 'loading') {
    return <div className="container mx-auto px-4 py-16 text-center text-stone-600">{t('admin.loading')}</div>;
  }

  if (access === 'signed_out') {
    return (
      <main className="container mx-auto max-w-lg px-4 py-14">
        <div className="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm sm:p-9">
          <h1 className="font-serif text-3xl font-bold text-brand-900">{t('admin.title')}</h1>
          <p className="mt-2 text-stone-600">{t('admin.loginDescription')}</p>
          <form className="mt-7 space-y-5" onSubmit={signIn}>
            <label className="block text-sm font-semibold" htmlFor="admin-email">
              {t('admin.email')}
              <input id="admin-email" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3 font-normal outline-none focus:border-brand-700 focus:ring-2 focus:ring-brand-100" />
            </label>
            <label className="block text-sm font-semibold" htmlFor="admin-password">
              {t('admin.password')}
              <input id="admin-password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-stone-300 px-4 py-3 font-normal outline-none focus:border-brand-700 focus:ring-2 focus:ring-brand-100" />
            </label>
            {loginError ? <p role="alert" className="text-sm text-red-700">{t('admin.loginFailed')}</p> : null}
            <button type="submit" disabled={loginPending} className="w-full rounded-xl bg-brand-800 px-5 py-3 font-semibold text-white hover:bg-brand-900 disabled:opacity-60">
              {loginPending ? t('admin.loading') : t('admin.signIn')}
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (access === 'denied') {
    return (
      <main className="container mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="font-serif text-3xl font-bold text-brand-900">{t('admin.accessDenied')}</h1>
        <button type="button" onClick={() => void supabase.auth.signOut()} className="mt-6 rounded-xl border border-stone-300 px-5 py-3 font-semibold hover:bg-stone-50">{t('admin.signOut')}</button>
      </main>
    );
  }

  return (
    <main className="container mx-auto space-y-6 px-4 py-8 md:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-serif text-3xl font-bold text-brand-900">{t('admin.title')}</h1>
          <p className="mt-2 text-stone-600">{t('admin.description')}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setRefreshKey(value => value + 1)} disabled={listLoading} className="rounded-xl border border-stone-300 px-4 py-2.5 font-semibold hover:bg-stone-50 disabled:opacity-60">{t('admin.refresh')}</button>
          <button type="button" onClick={() => void supabase.auth.signOut()} className="rounded-xl border border-stone-300 px-4 py-2.5 font-semibold hover:bg-stone-50">{t('admin.signOut')}</button>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="text-sm font-medium text-stone-700">{t('admin.serviceFilter')}
          <select value={serviceFilter} onChange={event => { setServiceFilter(event.target.value as typeof serviceFilter); setPage(0); }} className="ml-2 rounded-lg border border-stone-300 bg-white px-3 py-2">
            <option value="all">{t('admin.all')}</option><option value="housing">{t('admin.serviceTypes.housing')}</option><option value="assistance">{t('admin.serviceTypes.assistance')}</option>
          </select>
        </label>
        <label className="text-sm font-medium text-stone-700">{t('admin.statusFilter')}
          <select value={statusFilter} onChange={event => { setStatusFilter(event.target.value as typeof statusFilter); setPage(0); }} className="ml-2 rounded-lg border border-stone-300 bg-white px-3 py-2">
            <option value="all">{t('admin.all')}</option>{statuses.map(status => <option key={status} value={status}>{t(`admin.statuses.${status}`)}</option>)}
          </select>
        </label>
      </div>

      {listError ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-800">{t('admin.error')} <button className="ml-2 underline" onClick={() => setRefreshKey(value => value + 1)}>{t('admin.retry')}</button></div> : null}

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm" aria-label={t('admin.title')}>
          {listLoading ? <p className="p-10 text-center text-stone-600">{t('admin.loading')}</p> : rows.length === 0 ? <p className="p-10 text-center text-stone-600">{t('admin.empty')}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-stone-50 text-stone-600"><tr><th className="px-4 py-3">{t('admin.name')}</th><th className="px-4 py-3">{t('admin.format')}</th><th className="px-4 py-3">{t('admin.status')}</th></tr></thead>
                <tbody>{rows.map(row => (
                  <tr key={row.id} className={`cursor-pointer border-t border-stone-100 align-top hover:bg-stone-50 ${selected?.id === row.id ? 'bg-brand-50' : ''}`} onClick={() => setSelectedId(row.id)}>
                    <td className="px-4 py-4"><span className="font-semibold">{row.customer_name}</span><span className="mt-1 block text-xs text-stone-500">{formatDate(row.created_at, locale)}</span></td>
                    <td className="px-4 py-4">{t(`admin.serviceTypes.${row.service_type}`)}<span className="mt-1 block text-xs text-stone-500">{row.contact_value}</span></td>
                    <td className="px-4 py-4"><span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs">{t(`admin.statuses.${row.status}`)}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>

        {selected ? <section className="h-fit rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:p-7">
          <h2 className="font-serif text-2xl font-bold text-brand-900">{t('admin.details')}</h2>
          <p className="mt-1 text-sm text-stone-500">{selected.customer_name} · {formatDate(selected.created_at, locale)}</p>
          <dl className="mt-6 space-y-4 text-sm">
            <div><dt className="font-semibold text-stone-500">{t('admin.contact')}</dt><dd className="mt-1 break-words">{t(`contactMethods.${selected.contact_method}`)}: {selected.contact_value}{contactUrl(selected) ? <> · <a className="text-brand-800 underline" href={contactUrl(selected) ?? undefined} target="_blank" rel="noreferrer">{selected.contact_method}</a></> : null}</dd></div>
            <div><dt className="font-semibold text-stone-500">{t('admin.descriptionLabel')}</dt><dd className="mt-1 whitespace-pre-wrap">{selected.description.trim() || t('admin.noDescription')}</dd></div>
            <div><dt className="font-semibold text-stone-500">{t('admin.details')}</dt><dd className="mt-1 space-y-1">{Object.entries(selectedDetails).map(([key, value]) => <div key={key} className="break-words"><span className="text-stone-500">{key.replace(/_/g, ' ')}:</span> {String(value ?? '—')}</div>)}</dd></div>
            <div><dt className="font-semibold text-stone-500">{t('admin.format')}</dt><dd className="mt-1">{selected.indicative_price_vnd === null ? t('form.discuss') : `${selected.price_kind === 'from' ? (locale === 'ru' ? 'От ' : 'From ') : ''}${new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US').format(selected.indicative_price_vnd)} ₫`}<span className="mt-1 block text-xs text-stone-500">{t('admin.notAgreed')}</span></dd></div>
          </dl>
          <div className="mt-6 space-y-4 border-t border-stone-200 pt-5">
            <label className="block text-sm font-semibold" htmlFor="request-status">{t('admin.status')}
              <select id="request-status" value={draftStatus} onChange={event => setDraftStatus(event.target.value as RequestStatus)} className="mt-2 block w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 font-normal">
                {[selected.status, ...allowedNext[selected.status]].map(status => <option key={status} value={status}>{t(`admin.statuses.${status}`)}</option>)}
              </select>
            </label>
            <label className="block text-sm font-semibold" htmlFor="admin-note">{t('admin.note')}
              <textarea id="admin-note" rows={4} maxLength={5000} value={draftNote} onChange={event => setDraftNote(event.target.value)} className="mt-2 block w-full resize-y rounded-lg border border-stone-300 px-3 py-2.5 font-normal outline-none focus:border-brand-700 focus:ring-2 focus:ring-brand-100" />
            </label>
            {saveError ? <p role="alert" className="text-sm text-red-700">{saveError}</p> : null}
            {saved ? <p role="status" className="text-sm text-green-800">{t('admin.saved')}</p> : null}
            <button type="button" onClick={() => void saveRequest()} disabled={savePending} className="rounded-xl bg-brand-800 px-5 py-3 font-semibold text-white hover:bg-brand-900 disabled:opacity-60">{savePending ? t('admin.saving') : t('admin.save')}</button>
          </div>
        </section> : null}
      </div>

      <div className="flex items-center justify-between">
        <button type="button" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))} className="rounded-lg border border-stone-300 px-4 py-2 disabled:opacity-40">{t('admin.previous')}</button>
        <span className="text-sm text-stone-600">{t('admin.page', { page: page + 1, pages })}</span>
        <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)} className="rounded-lg border border-stone-300 px-4 py-2 disabled:opacity-40">{t('admin.next')}</button>
      </div>
    </main>
  );
};

export default AdminRequests;
