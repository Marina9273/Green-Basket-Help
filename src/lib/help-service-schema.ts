import { z } from 'zod';

export const HELP_CONSENT_VERSION = 'help-request-v1';

export const serviceTypes = ['housing', 'assistance'] as const;
export const contactMethods = ['telegram', 'whatsapp', 'zalo', 'email'] as const;
export const preferredLanguages = ['english', 'russian', 'vietnamese', 'other'] as const;
export const stayDurations = ['three_to_six_months', 'over_six_months', 'living_here', 'other', 'not_specified'] as const;

export type ServiceType = (typeof serviceTypes)[number];
export type ContactMethod = (typeof contactMethods)[number];
export type PreferredLanguage = (typeof preferredLanguages)[number];
export type StayDuration = (typeof stayDurations)[number];

const optionalText = (max: number, min = 0) =>
  z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(min).max(max).optional(),
  );

const optionalInteger = (min: number, max: number) =>
  z.preprocess(
    value => (value === '' || value === null || value === undefined ? undefined : Number(value)),
    z.number().int().min(min).max(max).optional(),
  );

const commonFields = {
  idempotency_key: z.string().uuid(),
  customer_name: z.string().trim().min(2).max(100),
  contact_method: z.enum(contactMethods),
  contact_value: z.string().trim().max(254),
  preferred_language: z.enum(preferredLanguages),
  language_other: optionalText(80, 2),
  stay_duration: z.enum(stayDurations),
  stay_other: optionalText(100, 2),
  description: z.string().trim().max(2000),
  privacy_consent: z.literal(true),
  consent_version: z.literal(HELP_CONSENT_VERSION),
  locale: z.enum(['en', 'ru']),
};

const housingDetails = z
  .object({
    plan: z.enum(['single_property', 'package', 'discuss']),
    rental_budget_vnd: optionalInteger(1, 1_000_000_000),
    preferred_areas: optionalText(300),
    move_in_date: optionalText(10),
    property_type: z.enum(['apartment', 'house', 'studio', 'other', 'undecided']),
    bedrooms: optionalInteger(0, 20),
    residents: optionalInteger(1, 30),
    pets: z.enum(['yes', 'no', 'undecided']),
    property_url: optionalText(2000),
  })
  .strict();

const assistanceDetails = z
  .object({
    category: z.enum(['household', 'medical', 'documents', 'business', 'legal', 'other']),
    format: z.enum(['online', 'offline', 'undecided']),
    preferred_date: optionalText(10),
    location: optionalText(300),
  })
  .strict();

export const housingHelpRequestSchema = z
  .object({ service_type: z.literal('housing'), details: housingDetails, ...commonFields })
  .strict();

export const assistanceHelpRequestSchema = z
  .object({ service_type: z.literal('assistance'), details: assistanceDetails, ...commonFields })
  .strict();

export const helpRequestSchema = z
  .discriminatedUnion('service_type', [housingHelpRequestSchema, assistanceHelpRequestSchema])
  .superRefine((value, ctx) => {
    const contact = value.contact_value;
    if (value.contact_method === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contact_value'], message: 'invalid' });
    }

    if ((value.contact_method === 'whatsapp' || value.contact_method === 'zalo') && !/^\+?[1-9]\d{7,14}$/.test(contact.replace(/[\s()-]/g, ''))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contact_value'], message: 'invalid' });
    }

    if (value.contact_method === 'telegram' && !/^@?[A-Za-z][A-Za-z0-9_]{4,31}$/.test(contact)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contact_value'], message: 'invalid' });
    }

    if (value.preferred_language === 'other' && !value.language_other) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['language_other'], message: 'required' });
    }

    if (value.stay_duration === 'other' && !value.stay_other) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stay_other'], message: 'required' });
    }

    if (value.service_type === 'housing' && value.details.move_in_date && !isTodayOrFutureInDaNang(value.details.move_in_date)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['details', 'move_in_date'], message: 'date_in_past' });
    }

    if (value.service_type === 'assistance' && value.details.preferred_date && !isTodayOrFutureInDaNang(value.details.preferred_date)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['details', 'preferred_date'], message: 'date_in_past' });
    }

    if (value.service_type === 'housing' && value.details.property_url) {
      try {
        const url = new URL(value.details.property_url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['details', 'property_url'], message: 'invalid' });
        }
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['details', 'property_url'], message: 'invalid' });
      }
    }
  });

export type HelpRequestPayload = z.infer<typeof helpRequestSchema>;
export type HousingHelpRequestPayload = z.infer<typeof housingHelpRequestSchema>;
export type AssistanceHelpRequestPayload = z.infer<typeof assistanceHelpRequestSchema>;

export const createIdempotencyKey = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const getTodayInDaNang = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());

export const isTodayOrFutureInDaNang = (date: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const isRealDate = parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  return isRealDate && date >= getTodayInDaNang();
};

export const getHelpIndicativePriceLabel = (
  serviceType: ServiceType,
  plan: 'single_property' | 'package' | 'discuss' | null,
) => ({ serviceType, plan });
