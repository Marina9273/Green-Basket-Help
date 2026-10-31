import { isSupabaseConfigured, supabase } from '@/integrations/supabase/client';
import type { HelpRequestPayload } from '@/lib/help-service-schema';

export interface HelpRequestReceipt {
  request_id: string;
  status: 'new';
  indicative_price_vnd: number | null;
  price_kind: 'per_property' | 'package' | 'from' | 'undetermined';
}

export interface HelpRequestSubmitError {
  status: number;
  code: string;
  fieldErrors?: Record<string, string>;
}

const readFunctionError = async (error: unknown): Promise<HelpRequestSubmitError> => {
  const candidate = error as {
    status?: number;
    message?: string;
    context?: Response;
  };

  let body: { error?: string; field_errors?: Record<string, string> } | null = null;
  if (candidate.context instanceof Response) {
    try {
      body = await candidate.context.clone().json();
    } catch {
      body = null;
    }
  }

  return {
    status: candidate.status ?? (candidate.context?.status || 500),
    code: body?.error ?? candidate.message ?? 'internal_error',
    fieldErrors: body?.field_errors,
  };
};

export const submitHelpServiceRequest = async (payload: HelpRequestPayload) => {
  if (!isSupabaseConfigured) {
    throw { status: 503, code: 'internal_error' } satisfies HelpRequestSubmitError;
  }

  const { data, error } = await supabase.functions.invoke<HelpRequestReceipt>('create-help-service-request', {
    body: payload,
  });

  if (error) {
    throw await readFunctionError(error);
  }

  if (!data?.request_id) {
    throw { status: 500, code: 'internal_error' } satisfies HelpRequestSubmitError;
  }

  return data;
};
