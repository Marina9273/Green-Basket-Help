-- Concierge requests live in a separate Supabase project and schema.
-- It deliberately does not reference products, carts, orders, product pricing or delivery tables.

CREATE TABLE IF NOT EXISTS public.help_service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key uuid NOT NULL UNIQUE,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  service_type text NOT NULL CHECK (service_type IN ('housing', 'assistance')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'in_progress', 'completed', 'cancelled')),
  customer_name text NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 2 AND 100),
  contact_method text NOT NULL CHECK (contact_method IN ('telegram', 'whatsapp', 'zalo', 'email')),
  contact_value text NOT NULL CHECK (char_length(contact_value) BETWEEN 1 AND 254),
  preferred_language text NOT NULL CHECK (preferred_language IN ('english', 'russian', 'vietnamese', 'other')),
  language_other text NULL CHECK (language_other IS NULL OR char_length(btrim(language_other)) BETWEEN 2 AND 80),
  stay_duration text NOT NULL CHECK (stay_duration IN ('three_to_six_months', 'over_six_months', 'living_here', 'other', 'not_specified')),
  stay_other text NULL CHECK (stay_other IS NULL OR char_length(btrim(stay_other)) BETWEEN 2 AND 100),
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 0 AND 2000),
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  locale text NOT NULL CHECK (locale IN ('en', 'ru')),
  indicative_price_vnd integer NULL CHECK (indicative_price_vnd IS NULL OR indicative_price_vnd >= 0),
  price_kind text NOT NULL CHECK (price_kind IN ('per_property', 'one_time', 'package', 'from', 'undetermined')),
  consent_at timestamptz NOT NULL,
  consent_version text NOT NULL CHECK (char_length(consent_version) BETWEEN 1 AND 80),
  admin_note text NULL CHECK (admin_note IS NULL OR char_length(admin_note) <= 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS help_service_requests_status_created_idx
  ON public.help_service_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS help_service_requests_service_created_idx
  ON public.help_service_requests (service_type, created_at DESC);

ALTER TABLE public.help_service_requests ENABLE ROW LEVEL SECURITY;

-- No direct client access. Public creation is performed by the Edge Function with service_role;
-- admin reads/updates are performed by the whitelisted security-definer RPCs below.
REVOKE ALL ON TABLE public.help_service_requests FROM anon, authenticated;
GRANT ALL ON TABLE public.help_service_requests TO service_role;

CREATE TABLE IF NOT EXISTS public.help_service_rate_limits (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  request_count integer NOT NULL CHECK (request_count >= 0),
  window_started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

ALTER TABLE public.help_service_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.help_service_rate_limits FROM anon, authenticated;
GRANT ALL ON TABLE public.help_service_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.help_service_price_rows()
RETURNS TABLE (
  service_type text,
  plan text,
  indicative_price_vnd integer,
  price_kind text
)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT *
  FROM (VALUES
    ('housing'::text, 'single_property'::text, 200000::integer, 'one_time'::text),
    ('housing'::text, 'package'::text, 1500000::integer, 'package'::text),
    ('housing'::text, 'discuss'::text, NULL::integer, 'undetermined'::text),
    ('assistance'::text, 'assistance'::text, 150000::integer, 'from'::text)
  ) AS prices(service_type, plan, indicative_price_vnd, price_kind);
$$;

CREATE OR REPLACE FUNCTION public.resolve_help_service_price(
  p_service_type text,
  p_plan text DEFAULT NULL
)
RETURNS TABLE (
  service_type text,
  plan text,
  indicative_price_vnd integer,
  price_kind text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT price.service_type, price.plan, price.indicative_price_vnd, price.price_kind
  FROM public.help_service_price_rows() AS price
  WHERE price.service_type = p_service_type
    AND price.plan = CASE WHEN p_service_type = 'assistance' THEN 'assistance' ELSE p_plan END;
$$;

CREATE OR REPLACE FUNCTION public.get_help_service_prices()
RETURNS TABLE (
  service_type text,
  plan text,
  indicative_price_vnd integer,
  price_kind text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT * FROM public.help_service_price_rows();
$$;

GRANT EXECUTE ON FUNCTION public.resolve_help_service_price(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_help_service_prices() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.consume_help_service_rate_limit(
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_count integer;
  current_expires timestamptz;
  next_expires timestamptz;
BEGIN
  IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$' OR p_limit < 1 OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'invalid_rate_limit_arguments' USING ERRCODE = '22023';
  END IF;

  -- Serialize updates for one keyed bucket across Edge instances.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key_hash, 0));
  SELECT request_count, expires_at
    INTO current_count, current_expires
    FROM public.help_service_rate_limits
   WHERE key_hash = p_key_hash
   FOR UPDATE;

  IF NOT FOUND OR current_expires <= now() THEN
    next_expires := now() + make_interval(secs => p_window_seconds);
    INSERT INTO public.help_service_rate_limits (key_hash, request_count, window_started_at, expires_at)
    VALUES (p_key_hash, 1, now(), next_expires)
    ON CONFLICT (key_hash) DO UPDATE SET
      request_count = EXCLUDED.request_count,
      window_started_at = EXCLUDED.window_started_at,
      expires_at = EXCLUDED.expires_at;
    RETURN QUERY SELECT true, 0;
    RETURN;
  END IF;

  IF current_count >= p_limit THEN
    RETURN QUERY SELECT false, GREATEST(1, ceil(extract(epoch FROM (current_expires - now())))::integer);
    RETURN;
  END IF;

  UPDATE public.help_service_rate_limits
     SET request_count = current_count + 1
   WHERE key_hash = p_key_hash;
  RETURN QUERY SELECT true, 0;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_help_service_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_help_service_rate_limit(text, integer, integer) TO service_role;

-- Concierge admins are marked with the server-controlled app_metadata claim.
-- This project has its own Supabase Auth; it does not depend on Green Basket roles.
CREATE OR REPLACE FUNCTION public.is_concierge_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, auth
AS $$
  SELECT COALESCE(auth.jwt() -> 'app_metadata' ->> 'role' = 'concierge_admin', false);
$$;

REVOKE ALL ON FUNCTION public.is_concierge_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_concierge_admin() TO authenticated;

CREATE OR REPLACE FUNCTION public.list_help_service_requests(
  p_page integer DEFAULT 0,
  p_page_size integer DEFAULT 25,
  p_service_type text DEFAULT NULL,
  p_status text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  service_type text,
  status text,
  customer_name text,
  contact_method text,
  contact_value text,
  preferred_language text,
  language_other text,
  stay_duration text,
  stay_other text,
  description text,
  details jsonb,
  locale text,
  indicative_price_vnd integer,
  price_kind text,
  consent_at timestamptz,
  consent_version text,
  admin_note text,
  created_at timestamptz,
  updated_at timestamptz,
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  safe_page integer := GREATEST(COALESCE(p_page, 0), 0);
  safe_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 25), 1), 25);
BEGIN
  IF NOT public.is_concierge_admin() THEN
    RAISE EXCEPTION 'help_service_admin_required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    request.id,
    request.service_type,
    request.status,
    request.customer_name,
    request.contact_method,
    request.contact_value,
    request.preferred_language,
    request.language_other,
    request.stay_duration,
    request.stay_other,
    request.description,
    request.details,
    request.locale,
    request.indicative_price_vnd,
    request.price_kind,
    request.consent_at,
    request.consent_version,
    request.admin_note,
    request.created_at,
    request.updated_at,
    count(*) OVER ()
  FROM public.help_service_requests AS request
  WHERE (p_service_type IS NULL OR request.service_type = p_service_type)
    AND (p_status IS NULL OR request.status = p_status)
  ORDER BY request.created_at DESC
  LIMIT safe_page_size
  OFFSET safe_page * safe_page_size;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_help_service_request(
  p_request_id uuid,
  p_expected_updated_at timestamptz,
  p_status text,
  p_admin_note text DEFAULT NULL
)
RETURNS TABLE (id uuid, status text, admin_note text, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_status text;
  current_updated_at timestamptz;
BEGIN
  IF NOT public.is_concierge_admin() THEN
    RAISE EXCEPTION 'help_service_admin_required' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('new', 'contacted', 'in_progress', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'help_service_invalid_status' USING ERRCODE = '22023';
  END IF;

  SELECT request.status, request.updated_at
    INTO current_status, current_updated_at
    FROM public.help_service_requests AS request
   WHERE request.id = p_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'help_service_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF current_updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'help_service_request_conflict' USING ERRCODE = '40001';
  END IF;

  IF current_status <> p_status AND NOT (
    (current_status = 'new' AND p_status IN ('contacted', 'cancelled')) OR
    (current_status = 'contacted' AND p_status IN ('in_progress', 'cancelled')) OR
    (current_status = 'in_progress' AND p_status IN ('completed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'help_service_invalid_transition' USING ERRCODE = '22023';
  END IF;

  IF p_admin_note IS NOT NULL AND char_length(p_admin_note) > 5000 THEN
    RAISE EXCEPTION 'help_service_note_too_long' USING ERRCODE = '22001';
  END IF;

  RETURN QUERY
  UPDATE public.help_service_requests AS request
     SET status = p_status,
         admin_note = COALESCE(p_admin_note, request.admin_note),
         updated_at = now()
   WHERE request.id = p_request_id
     AND request.updated_at = p_expected_updated_at
  RETURNING request.id, request.status, request.admin_note, request.updated_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'help_service_request_conflict' USING ERRCODE = '40001';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.list_help_service_requests(integer, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_help_service_requests(integer, integer, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.update_help_service_request(uuid, timestamptz, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_help_service_request(uuid, timestamptz, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.help_service_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS help_service_requests_updated_at ON public.help_service_requests;
CREATE TRIGGER help_service_requests_updated_at
  BEFORE UPDATE ON public.help_service_requests
  FOR EACH ROW EXECUTE FUNCTION public.help_service_updated_at();

SELECT pg_notify('pgrst', 'reload schema');
