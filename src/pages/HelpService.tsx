import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronDown,
  ClipboardCheck,
  FileCheck2,
  Languages,
  Loader2,
  MapPin,
  MessageCircle,
  Search,
  ShieldCheck,
  Video,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import apartmentViewingImage from '@/assets/concierge-apartment-viewing.png';
import homeInspectionImage from '@/assets/concierge-home-inspection.png';
import daoNguyenPortrait from '@/assets/dao-nguyen-realtor.png';
import { supabase } from '@/integrations/supabase/client';
import { trackHelpEvent } from '@/lib/help-service-analytics';
import {
  createIdempotencyKey,
  helpRequestSchema,
  HELP_CONSENT_VERSION,
  type AssistanceHelpRequestPayload,
  type HelpRequestPayload,
  type HousingHelpRequestPayload,
  type ServiceType,
} from '@/lib/help-service-schema';
import { submitHelpServiceRequest, type HelpRequestSubmitError } from '@/hooks/useHelpServiceRequest';

type PriceRow = {
  service_type: string;
  plan: string;
  indicative_price_vnd: number | null;
  price_kind: string;
};

type HousingDetails = HousingHelpRequestPayload['details'];
type AssistanceDetails = AssistanceHelpRequestPayload['details'];

type HelpFormState = Omit<HelpRequestPayload, 'details' | 'privacy_consent'> & {
  privacy_consent: boolean;
  details: HousingDetails | AssistanceDetails;
};

type SubmitState = 'idle' | 'validating' | 'submitting' | 'success' | 'error';
type Locale = 'en' | 'ru';
type HousingPlan = HousingDetails['plan'];

const APPROVED_PRICE_FALLBACKS: Record<'single_property' | 'package', number> = {
  single_property: 200_000,
  package: 1_500_000,
};

const formatVnd = (value: number, locale: Locale) =>
  `${new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US').format(value)} ₫`;

const makeInitialForm = (
  serviceType: ServiceType = 'housing',
  plan: HousingPlan = 'single_property',
  locale: Locale = 'en',
): HelpFormState => ({
  idempotency_key: createIdempotencyKey(),
  service_type: serviceType,
  customer_name: '',
  contact_method: 'telegram',
  contact_value: '',
  preferred_language: locale === 'ru' ? 'russian' : 'english',
  language_other: undefined,
  stay_duration: 'not_specified',
  stay_other: undefined,
  description: '',
  privacy_consent: false,
  consent_version: HELP_CONSENT_VERSION,
  locale,
  details: serviceType === 'housing'
    ? {
        plan,
        property_type: 'undecided',
        pets: 'undecided',
        rental_budget_vnd: undefined,
        preferred_areas: undefined,
        move_in_date: undefined,
        bedrooms: undefined,
        residents: undefined,
        property_url: undefined,
      }
    : {
        category: 'other',
        format: 'undecided',
        preferred_date: undefined,
        location: undefined,
      },
});

const HelpService = () => {
  const { t, i18n } = useTranslation('help');
  const searchParams = new URLSearchParams(window.location.search);
  const locale: Locale = i18n.resolvedLanguage?.startsWith('ru') ? 'ru' : 'en';
  const initialService: ServiceType = searchParams.get('service') === 'assistance' ? 'assistance' : 'housing';
  const [form, setForm] = useState<HelpFormState>(() => makeInitialForm(initialService, 'single_property', locale));
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  const formStartedRef = useRef(false);

  const pricesQuery = useQuery({
    queryKey: ['help-service-prices'],
    queryFn: async (): Promise<PriceRow[]> => {
      const { data, error } = await supabase.rpc('get_help_service_prices');
      if (error) throw error;
      return (data ?? []) as PriceRow[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const prices = useMemo(() => {
    const map = new Map<string, PriceRow>();
    for (const price of pricesQuery.data ?? []) map.set(`${price.service_type}:${price.plan}`, price);
    return map;
  }, [pricesQuery.data]);

  useEffect(() => {
    setForm(previous => ({
      ...previous,
      locale,
      preferred_language: locale === 'ru' ? 'russian' : 'english',
    }));
  }, [locale]);

  useEffect(() => {
    document.title = t('meta.title');
    const description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute('content', t('meta.description'));
  }, [t, locale]);

  useEffect(() => {
    trackHelpEvent('help_page_view', { locale });
  }, [locale]);

  const updateForm = (patch: Partial<HelpFormState>) => {
    setForm(previous => ({ ...previous, ...patch, locale }));
  };

  const focusForm = (serviceType: ServiceType, plan: HousingPlan = 'single_property') => {
    setForm(previous => ({
      ...previous,
      service_type: serviceType,
      locale,
      preferred_language: locale === 'ru' ? 'russian' : 'english',
      details: serviceType === 'housing'
        ? {
            plan,
            property_type: 'undecided',
            pets: 'undecided',
            rental_budget_vnd: undefined,
            preferred_areas: undefined,
            move_in_date: undefined,
            bedrooms: undefined,
            residents: undefined,
            property_url: undefined,
          }
        : {
            category: 'other',
            format: 'undecided',
            preferred_date: undefined,
            location: undefined,
          },
    }));
    setFieldErrors({});
    setSubmitError(null);
    setReceipt(null);
    setSubmitState('idle');
    trackHelpEvent('help_service_select', { locale, service_type: serviceType });
    window.setTimeout(() => {
      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      formHeadingRef.current?.focus();
    }, 0);
  };

  const getError = (path: string) => fieldErrors[path];
  const describedBy = (path: string) => getError(path) ? `${path.split('.').join('-')}-error` : undefined;
  const renderError = (path: string) => {
    const error = getError(path);
    return error ? <p id={`${path.split('.').join('-')}-error`} className="mt-1 text-sm text-destructive">{t(`form.errors.${error}`, { defaultValue: t('form.errors.invalid') })}</p> : null;
  };

  const validate = () => {
    const result = helpRequestSchema.safeParse({ ...form, locale });
    if (result.success) return result.data;
    const errors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join('.') || 'form';
      if (!errors[path]) errors[path] = issue.message || 'invalid';
    }
    setFieldErrors(errors);
    setSubmitError(null);
    const first = Object.keys(errors)[0];
    if (first) {
      window.setTimeout(() => {
        document.querySelector<HTMLElement>(`[data-field="${first}"]`)?.focus();
      }, 0);
    }
    return null;
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitState('validating');
    const payload = validate();
    if (!payload) {
      setSubmitState('error');
      trackHelpEvent('help_request_error', { locale, service_type: form.service_type, error_code: 'validation_error' });
      return;
    }

    setSubmitState('submitting');
    setSubmitError(null);
    setFieldErrors({});
    try {
      const result = await submitHelpServiceRequest(payload);
      setReceipt(result.request_id);
      setSubmitState('success');
      trackHelpEvent('help_request_success', { locale, service_type: form.service_type });
    } catch (error) {
      const requestError = error as HelpRequestSubmitError;
      setSubmitState('error');
      setSubmitError(requestError.code || 'internal_error');
      if (requestError.fieldErrors) setFieldErrors(requestError.fieldErrors);
      trackHelpEvent('help_request_error', { locale, service_type: form.service_type, error_code: requestError.code || 'internal_error' });
    }
  };

  const startAnother = () => {
    setReceipt(null);
    setSubmitError(null);
    setFieldErrors({});
    setSubmitState('idle');
    formStartedRef.current = false;
    setForm(makeInitialForm('housing', 'single_property', locale));
    window.setTimeout(() => formHeadingRef.current?.focus(), 0);
  };

  const onFormFocus = () => {
    if (formStartedRef.current) return;
    formStartedRef.current = true;
    trackHelpEvent('help_form_start', { locale, service_type: form.service_type });
  };

  const priceFor = (plan: HousingPlan) => {
    if (plan === 'discuss') return t('pricing.customPrice');
    const row = prices.get(`housing:${plan}`);
    const amount = row?.indicative_price_vnd ?? APPROVED_PRICE_FALLBACKS[plan];
    return formatVnd(amount, locale);
  };

  const inputClass = (path: string) => getError(path) ? 'border-destructive' : '';
  const selectedPlan = form.service_type === 'housing' ? (form.details as HousingDetails).plan : null;
  const selectedPlanKey = selectedPlan === 'package' ? 'package' : selectedPlan === 'discuss' ? 'custom' : 'single';
  const selectedServiceLabel = form.service_type === 'housing'
    ? t(`pricing.options.${selectedPlanKey}.title`)
    : t('otherConcierge.title');

  const plans: Array<{
    key: 'single' | 'package' | 'custom';
    plan: HousingPlan;
    features: string[];
    featured?: boolean;
  }> = [
    { key: 'single', plan: 'single_property', features: ['search', 'viewing', 'checklist', 'deal'] },
    { key: 'package', plan: 'package', features: ['everythingSingle', 'extraViewings', 'contract', 'deal'], featured: true },
    { key: 'custom', plan: 'discuss', features: ['customScope', 'confirmTerms'] },
  ];
  const comparisonSources = ['facebook', 'concierge'] as const;
  const comparisonRows = ['search', 'communication', 'viewing', 'agreement'] as const;
  const inspectionChecks = ['condition', 'noise', 'access', 'amenities', 'airConditioning', 'landlordAndAgreement'] as const;
  const steps = ['one', 'two', 'three'] as const;

  return (
    <div className="overflow-hidden bg-[#faf9f5] text-brand-950">
      <section className="relative isolate bg-gradient-to-br from-[#f4f0e6] via-white to-[#e7efe7]">
        <div className="container mx-auto grid gap-10 px-4 py-10 md:grid-cols-[1fr_0.95fr] md:items-center md:py-16 lg:gap-14 lg:py-20">
          <div className="max-w-2xl">
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-brand-200 bg-white/80 px-4 py-2 text-xs font-bold uppercase tracking-[0.16em] text-brand-800">
              <span className="h-2 w-2 rounded-full bg-brand-600" />{t('hero.eyebrow')}
            </p>
            <h1 className="font-serif text-4xl font-bold leading-[1.08] tracking-tight text-brand-950 sm:text-5xl lg:text-[3.75rem]">
              {t('hero.title')}
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-stone-700 sm:text-lg sm:leading-8">{t('hero.description')}</p>
            <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <Button size="lg" className="min-h-12 bg-brand-700 px-6 text-base hover:bg-brand-800" onClick={() => document.getElementById('packages')?.scrollIntoView({ behavior: 'smooth' })}>
                {t('hero.housingCta')} <ArrowDown aria-hidden="true" />
              </Button>
              <button type="button" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-brand-800 underline decoration-brand-300 underline-offset-4 hover:text-brand-950" onClick={() => focusForm('assistance')}>
                {t('hero.assistanceCta')} <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-stone-600">
              <span className="inline-flex items-center gap-2"><MapPin className="h-4 w-4 text-brand-700" />Da Nang</span>
              <span className="inline-flex items-center gap-2"><MessageCircle className="h-4 w-4 text-brand-700" />{t('hero.oneContact')}</span>
              <span className="inline-flex items-center gap-2"><Video className="h-4 w-4 text-brand-700" />{t('hero.remoteViewing')}</span>
            </div>
          </div>

          <figure className="relative min-h-[300px] overflow-hidden rounded-[1.75rem] shadow-[0_24px_70px_-32px_rgba(25,54,38,0.55)] sm:min-h-[420px]">
            <img src={apartmentViewingImage} alt={t('hero.imageAlt')} className="absolute inset-0 h-full w-full object-cover object-center" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-black/5" aria-hidden="true" />
            <figcaption className="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-4 p-5 text-white sm:p-7">
              <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/75">{t('hero.photoLabel')}</p><p className="mt-1 text-lg font-semibold">{t('hero.photoCaption')}</p></div>
              <span className="rounded-full border border-white/40 bg-white/15 px-3 py-1.5 text-xs font-medium backdrop-blur">{t('hero.illustration')}</span>
            </figcaption>
          </figure>
        </div>
      </section>

      <main>
        <section aria-label={t('benefits.title')} className="border-b border-stone-200 bg-white">
          <div className="container mx-auto grid gap-6 px-4 py-8 sm:grid-cols-3 sm:gap-8 sm:py-10">
            {(['filtered', 'local', 'checklist'] as const).map((benefit, index) => {
              const Icon = [Search, Languages, ClipboardCheck][index];
              return <div key={benefit} className="flex items-start gap-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-50 text-brand-700"><Icon className="h-5 w-5" aria-hidden="true" /></span>
                <div><h2 className="font-semibold text-brand-950">{t(`benefits.${benefit}.title`)}</h2><p className="mt-1 text-sm leading-6 text-stone-600">{t(`benefits.${benefit}.description`)}</p></div>
              </div>;
            })}
          </div>
        </section>

        <section id="packages" className="scroll-mt-20 px-4 py-16 sm:py-20" aria-labelledby="pricing-heading">
          <div className="container mx-auto">
            <div className="mb-9 max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-700">{t('pricing.eyebrow')}</p>
              <h2 id="pricing-heading" className="mt-3 font-serif text-3xl font-bold tracking-tight text-brand-950 sm:text-4xl">{t('pricing.title')}</h2>
              <p className="mt-3 leading-7 text-stone-600">{t('pricing.description')}</p>
            </div>

            <div className="grid items-stretch gap-5 lg:grid-cols-3">
              {plans.map(({ key, plan, features, featured }) => (
                <article key={key} className={`relative flex h-full flex-col rounded-3xl border p-6 shadow-sm sm:p-7 ${featured ? 'border-brand-700 bg-brand-900 text-white shadow-xl shadow-brand-900/15 lg:-mt-3 lg:mb-3' : 'border-stone-200 bg-white text-brand-950'}`}>
                  {featured ? <span className="absolute -top-3 left-6 rounded-full bg-[#dce8d7] px-3 py-1 text-xs font-bold uppercase tracking-wide text-brand-900">{t('pricing.popular')}</span> : null}
                  <div className="flex items-start justify-between gap-3">
                    <h3 className={`font-serif text-2xl font-bold ${featured ? 'text-white' : 'text-brand-950'}`}>{t(`pricing.options.${key}.title`)}</h3>
                    {key === 'single' ? <Search className="h-5 w-5 shrink-0 text-brand-600" aria-hidden="true" /> : key === 'package' ? <ShieldCheck className="h-5 w-5 shrink-0 text-[#dce8d7]" aria-hidden="true" /> : <MessageCircle className="h-5 w-5 shrink-0 text-brand-600" aria-hidden="true" />}
                  </div>
                  <p className={`mt-2 min-h-12 text-sm leading-6 ${featured ? 'text-white/75' : 'text-stone-600'}`}>{t(`pricing.options.${key}.description`)}</p>
                  <p className={`mt-5 font-serif text-4xl font-bold tracking-tight ${featured ? 'text-white' : 'text-brand-800'}`}>
                    {key === 'custom' ? t('pricing.customPrice') : priceFor(plan)}
                  </p>
                  <ul className="mt-6 flex-1 space-y-3">
                    {features.map(feature => <li key={feature} className={`flex items-start gap-3 text-sm leading-6 ${featured ? 'text-white/90' : 'text-stone-700'}`}><Check className={`mt-0.5 h-4 w-4 shrink-0 ${featured ? 'text-[#c5dbb9]' : 'text-brand-700'}`} aria-hidden="true" /><span>{t(`pricing.features.${feature}`)}</span></li>)}
                  </ul>
                  <Button className={`mt-8 min-h-12 w-full text-base ${featured ? 'bg-[#dce8d7] text-brand-950 hover:bg-white' : 'bg-brand-700 text-white hover:bg-brand-800'}`} onClick={() => focusForm('housing', plan)}>
                    {t('pricing.requestCta')} <ArrowRight aria-hidden="true" />
                  </Button>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="scroll-mt-20 bg-[#f0f3ec] px-4 py-14 sm:py-16" aria-labelledby="consultation-heading">
          <div className="container mx-auto grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
            <div className="lg:sticky lg:top-24">
              <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-brand-800"><MessageCircle className="h-4 w-4" />{t('form.stepLabel')}</span>
              <h2 id="consultation-heading" ref={formHeadingRef} tabIndex={-1} className="mt-4 font-serif text-3xl font-bold text-brand-950 outline-none sm:text-4xl">{t('form.title')}</h2>
              <p className="mt-4 max-w-md leading-7 text-stone-600">{t('form.description')}</p>
              <div className="mt-6 rounded-2xl border border-brand-200 bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{t('form.selectedLabel')}</p>
                <p className="mt-1 font-semibold text-brand-900">{selectedServiceLabel}</p>
              </div>
            </div>

            <form ref={formRef} onFocus={onFormFocus} onSubmit={handleSubmit} noValidate className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-8">
              {submitError ? <Alert variant="destructive" className="mb-6"><AlertTitle>{submitError === 'notification_pending' ? t('form.notificationPendingTitle') : t('form.errorTitle')}</AlertTitle><AlertDescription>{t(`form.errors.${submitError}`, { defaultValue: t('form.errors.internal_error') })}</AlertDescription><div className="mt-3 flex flex-wrap gap-2"><Button type="button" variant="outline" onClick={() => { setSubmitError(null); setSubmitState('idle'); }}>{t('form.retry')}</Button>{submitError === 'idempotency_conflict' ? <Button type="button" variant="outline" onClick={() => { updateForm({ idempotency_key: createIdempotencyKey() }); setSubmitError(null); setSubmitState('idle'); }}>{t('form.newIdempotency')}</Button> : null}</div></Alert> : null}

              {submitState === 'success' && receipt ? (
                <div className="rounded-2xl border border-brand-200 bg-brand-50 p-6" role="status">
                  <h3 className="text-xl font-semibold text-brand-900">{t('form.successTitle')}</h3>
                  <p className="mt-2 leading-7 text-stone-700">{t('form.successText')}</p>
                  <p className="mt-4 text-sm text-stone-500">{t('form.requestNumber')}: <span className="font-mono">{receipt}</span></p>
                  <Button type="button" className="mt-5 bg-brand-700 hover:bg-brand-800" onClick={startAnother}>{t('form.sendAnother')}</Button>
                </div>
              ) : (
                <fieldset disabled={submitState === 'submitting'} className="space-y-5">
                  <legend className="sr-only">{t('form.title')}</legend>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <div>
                      <label className="mb-2 block text-sm font-semibold" htmlFor="customer_name">{t('form.name')}</label>
                      <Input id="customer_name" name="customer_name" data-field="customer_name" value={form.customer_name} onChange={event => updateForm({ customer_name: event.target.value })} aria-invalid={Boolean(getError('customer_name'))} aria-describedby={describedBy('customer_name')} className={inputClass('customer_name')} />
                      {renderError('customer_name')}
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-semibold" htmlFor="contact_method">{t('form.contactMethod')}</label>
                      <select id="contact_method" name="contact_method" data-field="contact_method" value={form.contact_method} onChange={event => updateForm({ contact_method: event.target.value as HelpFormState['contact_method'] })} aria-invalid={Boolean(getError('contact_method'))} aria-describedby={describedBy('contact_method')} className={`flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${inputClass('contact_method')}`}>
                        {(['telegram', 'whatsapp', 'zalo', 'email'] as const).map(method => <option key={method} value={method}>{t(`contactMethods.${method}`)}</option>)}
                      </select>
                      {renderError('contact_method')}
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-semibold" htmlFor="contact_value">{t('form.contactValue')}</label>
                      <Input id="contact_value" name="contact_value" data-field="contact_value" value={form.contact_value} onChange={event => updateForm({ contact_value: event.target.value })} placeholder={t(`form.contactExamples.${form.contact_method}`)} aria-invalid={Boolean(getError('contact_value'))} aria-describedby={describedBy('contact_value')} className={inputClass('contact_value')} />
                      {renderError('contact_value')}
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-semibold" htmlFor="preferred_language">{t('form.preferredLanguage')}</label>
                      <select id="preferred_language" name="preferred_language" data-field="preferred_language" value={form.preferred_language} onChange={event => updateForm({ preferred_language: event.target.value as HelpFormState['preferred_language'] })} aria-invalid={Boolean(getError('preferred_language'))} aria-describedby={describedBy('preferred_language')} className={`flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${inputClass('preferred_language')}`}>
                        {(['english', 'russian', 'vietnamese', 'other'] as const).map(language => <option key={language} value={language}>{t(`languages.${language}`)}</option>)}
                      </select>
                      {renderError('preferred_language')}
                    </div>
                    {form.preferred_language === 'other' ? <div className="sm:col-span-2"><label className="mb-2 block text-sm font-semibold" htmlFor="language_other">{t('form.languageOther')}</label><Input id="language_other" name="language_other" data-field="language_other" value={form.language_other ?? ''} onChange={event => updateForm({ language_other: event.target.value })} aria-invalid={Boolean(getError('language_other'))} aria-describedby={describedBy('language_other')} />{renderError('language_other')}</div> : null}
                  </div>

                  <details className="group rounded-xl border border-stone-200 px-4 py-3">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-brand-900">{t('form.optionalNote')}<ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
                    <div className="pt-3">
                      <Textarea id="description" name="description" data-field="description" rows={3} maxLength={2000} value={form.description} onChange={event => updateForm({ description: event.target.value })} aria-invalid={Boolean(getError('description'))} aria-describedby="description-hint" />
                      <p id="description-hint" className="mt-2 text-xs leading-5 text-stone-500">{t('form.descriptionHint')}</p>
                      {renderError('description')}
                    </div>
                  </details>

                  <div className="space-y-2 border-t border-stone-100 pt-5">
                    <div className="flex items-start gap-3">
                      <Checkbox id="privacy_consent" checked={Boolean(form.privacy_consent)} onCheckedChange={checked => updateForm({ privacy_consent: checked === true })} aria-describedby={describedBy('privacy_consent')} />
                      <label htmlFor="privacy_consent" className="text-sm leading-6 text-stone-700">{t('form.privacy')}</label>
                    </div>
                    {renderError('privacy_consent')}
                    <p className="pl-7 text-xs leading-5 text-stone-500">{t('form.privacyMissing')}</p>
                  </div>

                  <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center">
                    <Button type="submit" size="lg" disabled={submitState === 'submitting' || submitState === 'validating'} className="min-h-12 bg-brand-700 px-6 text-base hover:bg-brand-800">
                      {submitState === 'submitting' || submitState === 'validating' ? <><Loader2 className="animate-spin" />{t('form.sending')}</> : <>{t('form.submit')} <ArrowRight aria-hidden="true" /></>}
                    </Button>
                    <span className="text-sm text-stone-500">{t('pricing.noPayment')}</span>
                  </div>
                </fieldset>
              )}
            </form>
          </div>
        </section>

        <section className="px-4 py-16 sm:py-20" aria-labelledby="comparison-heading">
          <div className="container mx-auto">
            <div className="mb-8 max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-700">{t('comparison.eyebrow')}</p>
              <h2 id="comparison-heading" className="mt-3 font-serif text-3xl font-bold text-brand-950 sm:text-4xl">{t('comparison.title')}</h2>
              <p className="mt-3 leading-7 text-stone-600">{t('comparison.description')}</p>
            </div>

            <div className="hidden overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-sm md:block">
              <table className="w-full table-fixed border-collapse text-left">
                <thead><tr className="bg-[#f4f5f0]">
                  <th scope="col" className="w-[19%] px-5 py-5 text-sm font-semibold text-stone-500">{t('comparison.rowHeading')}</th>
                  {comparisonSources.map(source => <th key={source} scope="col" className={`px-5 py-5 text-sm font-bold ${source === 'concierge' ? 'bg-brand-800 text-white' : 'text-brand-900'}`}>{t(`comparison.sources.${source}`)}</th>)}
                </tr></thead>
                <tbody>{comparisonRows.map((row, index) => <tr key={row} className={index < comparisonRows.length - 1 ? 'border-t border-stone-200' : ''}>
                  <th scope="row" className="px-5 py-5 align-top text-sm font-semibold text-brand-900">{t(`comparison.rows.${row}`)}</th>
                  {comparisonSources.map(source => <td key={source} className={`px-5 py-5 align-top text-sm leading-6 ${source === 'concierge' ? 'bg-brand-50/70 text-brand-950' : 'text-stone-600'}`}>{t(`comparison.cells.${source}.${row}`)}</td>)}
                </tr>)}</tbody>
              </table>
            </div>

            <div className="grid gap-4 md:hidden">
              {comparisonSources.map(source => <article key={source} className={`rounded-2xl border p-5 ${source === 'concierge' ? 'border-brand-700 bg-brand-900 text-white' : 'border-stone-200 bg-white'}`}>
                <h3 className="font-serif text-xl font-bold">{t(`comparison.sources.${source}`)}</h3>
                <dl className="mt-4 space-y-4">{comparisonRows.map(row => <div key={row} className="border-t border-current/10 pt-3"><dt className={`text-xs font-bold uppercase tracking-wide ${source === 'concierge' ? 'text-white/65' : 'text-stone-500'}`}>{t(`comparison.rows.${row}`)}</dt><dd className={`mt-1 text-sm leading-6 ${source === 'concierge' ? 'text-white/90' : 'text-stone-700'}`}>{t(`comparison.cells.${source}.${row}`)}</dd></div>)}</dl>
              </article>)}
            </div>
          </div>
        </section>

        <section className="bg-[#f5f6f1] px-4 py-16 sm:py-20" aria-labelledby="inspection-heading">
          <div className="container mx-auto grid items-center gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-14">
            <figure className="relative aspect-[4/3] overflow-hidden rounded-3xl bg-stone-200 shadow-lg">
              <img src={homeInspectionImage} alt={t('inspection.photoAlt')} className="absolute inset-0 h-full w-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-brand-950/55 via-transparent to-transparent" aria-hidden="true" />
              <figcaption className="absolute bottom-0 left-0 p-5 text-sm font-semibold text-white sm:p-6">{t('inspection.photoCaption')}</figcaption>
            </figure>

            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-700">{t('inspection.eyebrow')}</p>
              <h2 id="inspection-heading" className="mt-3 font-serif text-3xl font-bold leading-tight text-brand-950 sm:text-4xl">{t('inspection.title')}</h2>
              <p className="mt-4 max-w-2xl leading-7 text-stone-600">{t('inspection.description')}</p>
              <ul className="mt-7 grid gap-3 sm:grid-cols-2">
                {inspectionChecks.map(check => <li key={check} className="flex items-start gap-3 rounded-2xl border border-stone-200 bg-white/90 p-4 shadow-sm">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-800"><Check className="h-4 w-4" aria-hidden="true" /></span>
                  <span className="text-sm leading-6 text-stone-700">{t(`inspection.checks.${check}`)}</span>
                </li>)}
              </ul>
            </div>
          </div>
        </section>

        <section className="bg-brand-900 px-4 py-16 text-white sm:py-20" aria-labelledby="realtor-heading">
          <div className="container mx-auto grid gap-8 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)] lg:items-center lg:gap-12">
            <figure className="relative mx-auto aspect-[4/5] w-full max-w-[22rem] overflow-hidden rounded-[1.75rem] border border-white/15 bg-white/10 shadow-2xl lg:max-w-none">
              <img src={daoNguyenPortrait} alt={t('realtor.photoAlt')} className="absolute inset-0 h-full w-full object-cover object-top" />
              <div className="absolute inset-0 bg-gradient-to-t from-[#10241b]/85 via-transparent to-black/5" aria-hidden="true" />
              <figcaption className="absolute inset-x-0 bottom-0 p-5 sm:p-6">
                <span className="block h-1 w-9 rounded-full bg-[#c5dbb9]" aria-hidden="true" />
                <p className="mt-3 font-serif text-2xl font-bold tracking-tight text-white">{t('realtor.name')}</p>
              </figcaption>
            </figure>

            <div>
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-[#dce8d7]"><BadgeCheck className="h-7 w-7" aria-hidden="true" /></div>
              <p className="mt-6 text-xs font-bold uppercase tracking-[0.18em] text-[#c5dbb9]">{t('realtor.eyebrow')}</p>
              <h2 id="realtor-heading" className="mt-3 font-serif text-3xl font-bold leading-tight sm:text-4xl">{t('realtor.title')}</h2>
              <p className="mt-4 max-w-lg leading-7 text-white/75">{t('realtor.description')}</p>
              <p className="mt-6 border-l-2 border-[#c5dbb9] pl-4 text-sm leading-6 text-white/70">{t('realtor.noGuarantee')}</p>
              <div className="mt-8 grid gap-4 sm:grid-cols-2">
                <article className="rounded-2xl border border-white/15 bg-white/[0.07] p-5 sm:p-6">
                  <Search className="h-6 w-6 text-[#c5dbb9]" aria-hidden="true" />
                  <h3 className="mt-4 text-lg font-semibold">{t('realtor.databaseTitle')}</h3>
                  <p className="mt-2 text-sm leading-6 text-white/70">{t('realtor.databaseDescription')}</p>
                </article>
                <article className="rounded-2xl border border-white/15 bg-white/[0.07] p-5 sm:p-6">
                  <FileCheck2 className="h-6 w-6 text-[#c5dbb9]" aria-hidden="true" />
                  <h3 className="mt-4 text-lg font-semibold">{t('realtor.viewingTitle')}</h3>
                  <p className="mt-2 text-sm leading-6 text-white/70">{t('realtor.viewingDescription')}</p>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section className="px-4 py-16 sm:py-20" aria-labelledby="process-heading">
          <div className="container mx-auto">
            <div className="mb-8 max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-700">{t('process.eyebrow')}</p>
              <h2 id="process-heading" className="mt-3 font-serif text-3xl font-bold text-brand-950 sm:text-4xl">{t('process.title')}</h2>
            </div>
            <ol className="grid gap-4 md:grid-cols-3">
              {steps.map((step, index) => <li key={step} className="relative rounded-2xl border border-stone-200 bg-white p-6 sm:p-7">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 font-serif text-lg font-bold text-brand-800">0{index + 1}</span>
                <h3 className="mt-5 text-lg font-semibold text-brand-950">{t(`process.steps.${step}.title`)}</h3>
                <p className="mt-2 text-sm leading-6 text-stone-600">{t(`process.steps.${step}.description`)}</p>
              </li>)}
            </ol>
          </div>
        </section>

        <section id="other-concierge" className="px-4 pb-16 sm:pb-20" aria-labelledby="other-concierge-heading">
          <div className="container mx-auto">
            <div className="flex flex-col gap-6 rounded-3xl border border-brand-200 bg-[#edf2e9] p-6 sm:p-8 lg:flex-row lg:items-center lg:justify-between lg:p-10">
              <div className="max-w-2xl">
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-700">{t('otherConcierge.eyebrow')}</p>
                <h2 id="other-concierge-heading" className="mt-3 font-serif text-2xl font-bold text-brand-950 sm:text-3xl">{t('otherConcierge.title')}</h2>
                <p className="mt-3 leading-7 text-stone-700">{t('otherConcierge.description')}</p>
                <p className="mt-3 text-sm leading-6 text-stone-600">{t('otherConcierge.examples')}</p>
              </div>
              <Button size="lg" className="min-h-12 shrink-0 bg-brand-700 px-6 text-base hover:bg-brand-800" onClick={() => focusForm('assistance')}>
                {t('otherConcierge.cta')} <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default HelpService;
