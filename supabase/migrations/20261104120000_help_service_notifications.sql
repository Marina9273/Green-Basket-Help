-- Keep mail delivery state separate from request data. The outbox never stores
-- applicant contact details or message bodies; notification emails link to /admin.
CREATE TABLE IF NOT EXISTS public.help_service_notification_outbox (
  request_id uuid PRIMARY KEY REFERENCES public.help_service_requests(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at timestamptz NULL,
  sent_at timestamptz NULL,
  provider_message_id text NULL CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 200),
  last_error_code text NULL CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.help_service_notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.help_service_notification_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.help_service_notification_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_help_service_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.help_service_notification_outbox (request_id)
  VALUES (NEW.id)
  ON CONFLICT (request_id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_help_service_notification() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS help_service_requests_enqueue_notification ON public.help_service_requests;
CREATE TRIGGER help_service_requests_enqueue_notification
  AFTER INSERT ON public.help_service_requests
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_help_service_notification();

-- Backfill rows created before this migration, if any.
INSERT INTO public.help_service_notification_outbox (request_id)
SELECT request.id
FROM public.help_service_requests AS request
ON CONFLICT (request_id) DO NOTHING;
