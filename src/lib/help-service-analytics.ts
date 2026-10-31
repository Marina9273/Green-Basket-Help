import type { ServiceType } from '@/lib/help-service-schema';

export type HelpEventName =
  | 'help_page_view'
  | 'help_service_select'
  | 'help_form_start'
  | 'help_request_success'
  | 'help_request_error';

export const trackHelpEvent = (
  event: HelpEventName,
  payload: { locale: 'en' | 'ru'; service_type?: ServiceType; error_code?: string },
) => {
  if (typeof window === 'undefined') return;

  // Keep this adapter free of customer data. A future first-party analytics
  // integration can subscribe without introducing a second tracking SDK.
  window.dispatchEvent(
    new CustomEvent('concierge:help-event', {
      detail: { event, ...payload },
    }),
  );
};
