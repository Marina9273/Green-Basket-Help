import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import HelpService from '@/pages/HelpService';

const AdminRequests = lazy(() => import('@/pages/admin/AdminRequests'));

const AppFrame = () => {
  const { t, i18n } = useTranslation('help');
  const language = i18n.resolvedLanguage?.startsWith('ru') ? 'ru' : 'en';

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-stone-200 bg-white px-4">
        <div className="container mx-auto flex min-h-16 items-center justify-between gap-4">
          <a href="/" className="font-serif text-lg font-bold tracking-tight text-brand-900 sm:text-xl">
            {t('navigation')}
          </a>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-stone-500 sm:inline">Da Nang</span>
            <button
              type="button"
              className="rounded-full border border-stone-200 px-3 py-1.5 text-xs font-bold uppercase text-brand-800 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
              onClick={() => void i18n.changeLanguage(language === 'ru' ? 'en' : 'ru')}
              aria-label={language === 'ru' ? 'Switch language to English' : 'Сменить язык на русский'}
            >
              {language === 'ru' ? 'EN' : 'RU'}
            </button>
          </div>
        </div>
      </header>
      {window.location.pathname === '/admin' ? (
        <Suspense fallback={<div className="container mx-auto px-4 py-16 text-center text-stone-600">Loading…</div>}>
          <AdminRequests />
        </Suspense>
      ) : <HelpService />}
    </div>
  );
};

const App = () => <AppFrame />;

export default App;
