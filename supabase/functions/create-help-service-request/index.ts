import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_WINDOW_SECONDS = 10 * 60;
const CONSENT_VERSION = "help-request-v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEGRAM_RE = /^@?[A-Za-z][A-Za-z0-9_]{4,31}$/;
const DETAILS_KEYS = {
  housing: new Set([
    "plan",
    "rental_budget_vnd",
    "preferred_areas",
    "move_in_date",
    "property_type",
    "bedrooms",
    "residents",
    "pets",
    "property_url",
  ]),
  assistance: new Set(["category", "format", "preferred_date", "location"]),
} as const;

const priceKinds = new Set(["per_property", "one_time", "package", "from", "undetermined"]);

type JsonObject = Record<string, unknown>;

class ValidationError extends Error {
  constructor(public readonly fieldErrors: Record<string, string>) {
    super("validation_error");
  }
}

const configuredOrigins = () =>
  (Deno.env.get("HELP_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

const getCorsHeaders = (req: Request) => {
  const origin = req.headers.get("origin");
  const origins = configuredOrigins();
  const allowed = !origin || origins.includes(origin);

  return {
    "Access-Control-Allow-Origin": origin && origins.includes(origin) ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "x-help-origin-allowed": allowed ? "true" : "false",
  };
};

const response = (req: Request, body: JsonObject, status: number, extraHeaders: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(req),
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });

const getTodayInDaNang = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalText = (value: unknown, max: number, field: string, errors: Record<string, string>, min = 0) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    errors[field] = "invalid";
    return null;
  }
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length < min) errors[field] = "required";
  if (normalized.length > max) errors[field] = "too_long";
  return normalized;
};

const requiredText = (value: unknown, min: number, max: number, field: string, errors: Record<string, string>) => {
  if (typeof value !== "string") {
    errors[field] = "required";
    return "";
  }
  const normalized = value.trim();
  if (normalized.length < min) errors[field] = "required";
  if (normalized.length > max) errors[field] = "too_long";
  return normalized;
};

const enumValue = <T extends string>(value: unknown, values: readonly T[], field: string, errors: Record<string, string>) => {
  if (typeof value !== "string" || !values.includes(value as T)) {
    errors[field] = "invalid";
    return values[0];
  }
  return value as T;
};

const optionalInteger = (value: unknown, min: number, max: number, field: string, errors: Record<string, string>) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    errors[field] = "invalid";
    return null;
  }
  return value;
};

const ensureDetailsKeys = (details: JsonObject, allowed: ReadonlySet<string>, errors: Record<string, string>) => {
  for (const key of Object.keys(details)) {
    if (!allowed.has(key)) errors[`details.${key}`] = "invalid";
  }
};

const normalizeContact = (method: string, value: string, errors: Record<string, string>) => {
  if (method === "email") {
    const normalized = value.toLowerCase();
    if (!EMAIL_RE.test(normalized)) errors.contact_value = "invalid";
    return normalized;
  }

  if (method === "telegram") {
    const normalized = value.replace(/^@/, "");
    if (!TELEGRAM_RE.test(value)) errors.contact_value = "invalid";
    return normalized;
  }

  const normalized = value.replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) errors.contact_value = "invalid";
  return normalized;
};

const normalizeDate = (value: unknown, field: string, errors: Record<string, string>) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    errors[field] = "date_in_past";
    return null;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day || value < getTodayInDaNang()) {
    errors[field] = "date_in_past";
    return null;
  }
  return value;
};

const normalizeInput = (body: JsonObject) => {
  const errors: Record<string, string> = {};
  const allowedTopLevel = new Set([
    "idempotency_key",
    "service_type",
    "customer_name",
    "contact_method",
    "contact_value",
    "preferred_language",
    "language_other",
    "stay_duration",
    "stay_other",
    "description",
    "details",
    "locale",
    "privacy_consent",
    "consent_version",
  ]);

  for (const key of Object.keys(body)) {
    if (!allowedTopLevel.has(key)) errors[key] = "invalid";
  }

  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.toLowerCase() : "";
  if (!UUID_RE.test(idempotencyKey)) errors.idempotency_key = "invalid";

  const serviceType = enumValue(body.service_type, ["housing", "assistance"] as const, "service_type", errors);
  const customerName = requiredText(body.customer_name, 2, 100, "customer_name", errors);
  const contactMethod = enumValue(body.contact_method, ["telegram", "whatsapp", "zalo", "email"] as const, "contact_method", errors);
  const rawContact = requiredText(body.contact_value, 1, 254, "contact_value", errors);
  const contactValue = normalizeContact(contactMethod, rawContact, errors);
  const preferredLanguage = enumValue(body.preferred_language, ["english", "russian", "vietnamese", "other"] as const, "preferred_language", errors);
  const languageOther = optionalText(body.language_other, 80, "language_other", errors, 2);
  const stayDuration = enumValue(body.stay_duration, ["three_to_six_months", "over_six_months", "living_here", "other", "not_specified"] as const, "stay_duration", errors);
  const stayOther = optionalText(body.stay_other, 100, "stay_other", errors, 2);
  const description = requiredText(body.description, 0, 2000, "description", errors);
  const locale = enumValue(body.locale, ["en", "ru"] as const, "locale", errors);
  const details = body.details;

  if (body.privacy_consent !== true) errors.privacy_consent = "must_confirm";
  if (body.consent_version !== CONSENT_VERSION) errors.consent_version = "invalid";
  if (preferredLanguage === "other" && !languageOther) errors.language_other = "required";
  if (stayDuration === "other" && !stayOther) errors.stay_other = "required";

  if (!isPlainObject(details)) {
    errors.details = "required";
  }

  let normalizedDetails: JsonObject = {};
  if (isPlainObject(details)) {
    ensureDetailsKeys(details, DETAILS_KEYS[serviceType], errors);

    if (serviceType === "housing") {
      const plan = enumValue(details.plan, ["single_property", "package", "discuss"] as const, "details.plan", errors);
      const propertyType = enumValue(details.property_type, ["apartment", "house", "studio", "other", "undecided"] as const, "details.property_type", errors);
      const pets = enumValue(details.pets, ["yes", "no", "undecided"] as const, "details.pets", errors);
      const rentalBudget = optionalInteger(details.rental_budget_vnd, 1, 1_000_000_000, "details.rental_budget_vnd", errors);
      const areas = optionalText(details.preferred_areas, 300, "details.preferred_areas", errors);
      const moveInDate = normalizeDate(details.move_in_date, "details.move_in_date", errors);
      const bedrooms = optionalInteger(details.bedrooms, 0, 20, "details.bedrooms", errors);
      const residents = optionalInteger(details.residents, 1, 30, "details.residents", errors);
      const propertyUrl = optionalText(details.property_url, 2000, "details.property_url", errors);

      if (propertyUrl) {
        try {
          const url = new URL(propertyUrl);
          if (url.protocol !== "http:" && url.protocol !== "https:") errors["details.property_url"] = "invalid";
        } catch {
          errors["details.property_url"] = "invalid";
        }
      }

      normalizedDetails = {
        plan,
        rental_budget_vnd: rentalBudget,
        preferred_areas: areas,
        move_in_date: moveInDate,
        property_type: propertyType,
        bedrooms,
        residents,
        pets,
        property_url: propertyUrl,
      };
    } else {
      const category = enumValue(details.category, ["household", "medical", "documents", "business", "legal", "other"] as const, "details.category", errors);
      const format = enumValue(details.format, ["online", "offline", "undecided"] as const, "details.format", errors);
      const preferredDate = normalizeDate(details.preferred_date, "details.preferred_date", errors);
      const location = optionalText(details.location, 300, "details.location", errors);
      normalizedDetails = { category, format, preferred_date: preferredDate, location };
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationError(errors);

  return {
    idempotency_key: idempotencyKey,
    service_type: serviceType,
    customer_name: customerName,
    contact_method: contactMethod,
    contact_value: contactValue,
    preferred_language: preferredLanguage,
    language_other: languageOther,
    stay_duration: stayDuration,
    stay_other: stayOther,
    description,
    details: normalizedDetails,
    locale,
  };
};

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes)).map(byte => byte.toString(16).padStart(2, "0")).join("");

const hmacSha256 = async (secret: string, value: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
};

const getClientIp = (req: Request) => {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("cf-connecting-ip")?.trim() || "unknown";
};

const getAuthUserId = async (req: Request, supabaseUrl: string, anonKey: string) => {
  const authorization = req.headers.get("authorization");
  if (!authorization) return null;
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("invalid_session");
  // Guest supabase-js clients can put the project's public API key in the
  // Authorization header. It identifies the project, not an authenticated user.
  if (token === anonKey || token.startsWith("sb_publishable_")) return null;

  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("invalid_session");
  return data.user.id;
};

const getExistingReceipt = async (adminClient: ReturnType<typeof createClient>, idempotencyKey: string) => {
  const { data, error } = await adminClient
    .from("help_service_requests")
    .select("id,status,service_type,locale,indicative_price_vnd,price_kind,request_fingerprint")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw error;
  return data;
};

const deliverAdminNotification = async (
  adminClient: ReturnType<typeof createClient>,
  requestId: string,
  serviceType: "housing" | "assistance",
  locale: "en" | "ru",
) => {
  const { data: notification, error: notificationError } = await adminClient
    .from("help_service_notification_outbox")
    .select("status,attempt_count")
    .eq("request_id", requestId)
    .maybeSingle();

  if (notificationError || !notification) throw notificationError ?? new Error("notification_outbox_missing");
  if (notification.status === "sent") return true;

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const recipient = Deno.env.get("HELP_NOTIFICATION_TO");
  const sender = Deno.env.get("HELP_NOTIFICATION_FROM");
  if (!resendApiKey || !recipient || !sender || !EMAIL_RE.test(recipient)) {
    await adminClient
      .from("help_service_notification_outbox")
      .update({
        attempt_count: notification.attempt_count + 1,
        last_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_error_code: "notification_config_missing",
      })
      .eq("request_id", requestId);
    return false;
  }

  const attemptedAt = new Date().toISOString();
  const { error: attemptError } = await adminClient
    .from("help_service_notification_outbox")
    .update({
      attempt_count: notification.attempt_count + 1,
      last_attempt_at: attemptedAt,
      updated_at: attemptedAt,
      last_error_code: null,
    })
    .eq("request_id", requestId);
  if (attemptError) throw attemptError;

  const serviceLabel = locale === "ru"
    ? (serviceType === "housing" ? "подбор жилья" : "помощь консьержа")
    : (serviceType === "housing" ? "housing search" : "concierge assistance");
  const subject = locale === "ru" ? "Новая заявка Green Basket Concierge" : "New Green Basket Concierge request";
  const adminUrl = "https://concierge.green-basket.online/admin";
  const text = locale === "ru"
    ? `Поступила новая заявка: ${serviceLabel}.\nID: ${requestId}\nОткройте админ-панель: ${adminUrl}`
    : `A new request was received: ${serviceLabel}.\nID: ${requestId}\nOpen the admin panel: ${adminUrl}`;
  const html = `<p>${locale === "ru" ? "Поступила новая заявка" : "A new request was received"}: <strong>${serviceLabel}</strong>.</p><p>ID: <code>${requestId}</code></p><p><a href="${adminUrl}">${locale === "ru" ? "Открыть админ-панель" : "Open the admin panel"}</a></p>`;

  try {
    const providerResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `help-service-request/${requestId}`,
      },
      body: JSON.stringify({ from: sender, to: [recipient], subject, text, html }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!providerResponse.ok) {
      const providerBody = await providerResponse.json().catch(() => null);
      const providerCode = isPlainObject(providerBody) && typeof providerBody.name === "string"
        ? providerBody.name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60)
        : `http_${providerResponse.status}`;
      throw new Error(`resend_${providerCode || providerResponse.status}`);
    }

    const providerResult: unknown = await providerResponse.json().catch(() => null);
    const providerMessageId = isPlainObject(providerResult) && typeof providerResult.id === "string"
      ? providerResult.id.slice(0, 200)
      : null;
    const sentAt = new Date().toISOString();
    const { error: sentError } = await adminClient
      .from("help_service_notification_outbox")
      .update({
        status: "sent",
        sent_at: sentAt,
        updated_at: sentAt,
        provider_message_id: providerMessageId,
        last_error_code: null,
      })
      .eq("request_id", requestId);
    if (sentError) throw sentError;
    return true;
  } catch (error) {
    const errorCode = error instanceof Error
      ? error.message.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100)
      : "notification_delivery_failed";
    const failedAt = new Date().toISOString();
    const { error: failureUpdateError } = await adminClient
      .from("help_service_notification_outbox")
      .update({ updated_at: failedAt, last_error_code: errorCode })
      .eq("request_id", requestId);
    if (failureUpdateError) throw failureUpdateError;
    console.error(JSON.stringify({ request_id: requestId, code: "notification_delivery_failed", provider_code: errorCode }));
    return false;
  }
};

const handle = async (req: Request) => {
  const correlationId = crypto.randomUUID();
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    if (cors["x-help-origin-allowed"] !== "true") return new Response(null, { status: 403, headers: cors });
    return new Response(null, { status: 204, headers: cors });
  }

  if (cors["x-help-origin-allowed"] !== "true") return response(req, { error: "origin_not_allowed" }, 403);
  if (req.method !== "POST") return response(req, { error: "method_not_allowed" }, 405, { Allow: "POST, OPTIONS" });

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) return response(req, { error: "payload_too_large" }, 413);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const hmacSecret = Deno.env.get("HELP_RATE_LIMIT_HMAC_SECRET");
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !hmacSecret) {
    console.error(JSON.stringify({ correlation_id: correlationId, code: "configuration_missing", stage: "config" }));
    return response(req, { error: "internal_error" }, 500);
  }

  let rawBody: string;
  try {
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) return response(req, { error: "payload_too_large" }, 413);
    rawBody = new TextDecoder().decode(bytes);
  } catch {
    return response(req, { error: "validation_error", field_errors: { body: "invalid" } }, 400);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return response(req, { error: "validation_error", field_errors: { body: "invalid" } }, 400);
  }
  if (!isPlainObject(body)) return response(req, { error: "validation_error", field_errors: { body: "invalid" } }, 400);

  let normalized: ReturnType<typeof normalizeInput>;
  try {
    normalized = normalizeInput(body);
  } catch (error) {
    if (error instanceof ValidationError) {
      return response(req, { error: "validation_error", field_errors: error.fieldErrors }, 400);
    }
    console.error(JSON.stringify({ correlation_id: correlationId, code: "validation_exception", stage: "validation" }));
    return response(req, { error: "internal_error" }, 500);
  }

  let userId: string | null = null;
  try {
    userId = await getAuthUserId(req, supabaseUrl, anonKey);
  } catch {
    return response(req, { error: "invalid_session" }, 401);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const canonicalPayload = JSON.stringify(normalized);
  const requestFingerprint = await hmacSha256(hmacSecret, `payload:${canonicalPayload}`);

  try {
    const existing = await getExistingReceipt(adminClient, normalized.idempotency_key);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        return response(req, { error: "idempotency_conflict" }, 409);
      }
      const notificationSent = await deliverAdminNotification(
        adminClient,
        existing.id,
        existing.service_type,
        existing.locale,
      );
      if (!notificationSent) return response(req, { error: "notification_pending", request_id: existing.id }, 503);
      return response(req, {
        request_id: existing.id,
        status: existing.status,
        indicative_price_vnd: existing.indicative_price_vnd,
        price_kind: existing.price_kind,
      }, 200);
    }

    const ipHash = await hmacSha256(hmacSecret, `ip:${getClientIp(req)}`);
    const contactHash = await hmacSha256(hmacSecret, `contact:${normalized.contact_method}:${normalized.contact_value}`);
    const ipLimit = Number(Deno.env.get("HELP_RATE_LIMIT_IP") ?? "5");
    const contactLimit = Number(Deno.env.get("HELP_RATE_LIMIT_CONTACT") ?? "3");
    const windowSeconds = Number(Deno.env.get("HELP_RATE_LIMIT_WINDOW_SECONDS") ?? String(DEFAULT_WINDOW_SECONDS));

    for (const [keyHash, limit] of [[ipHash, ipLimit], [contactHash, contactLimit]] as const) {
      const { data, error } = await adminClient.rpc("consume_help_service_rate_limit", {
        p_key_hash: keyHash,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      if (error) throw error;
      const bucket = Array.isArray(data) ? data[0] : data;
      if (!bucket?.allowed) {
        return response(req, { error: "rate_limited" }, 429, {
          "Retry-After": String(bucket?.retry_after_seconds ?? windowSeconds),
        });
      }
    }

    const plan = normalized.service_type === "housing" ? String(normalized.details.plan) : null;
    const { data: prices, error: priceError } = await adminClient.rpc("resolve_help_service_price", {
      p_service_type: normalized.service_type,
      p_plan: plan,
    });
    if (priceError || !Array.isArray(prices) || prices.length !== 1) throw priceError ?? new Error("price_not_found");
    const price = prices[0];
    if (!priceKinds.has(price.price_kind)) throw new Error("invalid_price_kind");

    const { data: inserted, error: insertError } = await adminClient
      .from("help_service_requests")
      .insert({
        idempotency_key: normalized.idempotency_key,
        request_fingerprint: requestFingerprint,
        user_id: userId,
        service_type: normalized.service_type,
        customer_name: normalized.customer_name,
        contact_method: normalized.contact_method,
        contact_value: normalized.contact_value,
        preferred_language: normalized.preferred_language,
        language_other: normalized.language_other,
        stay_duration: normalized.stay_duration,
        stay_other: normalized.stay_other,
        description: normalized.description,
        details: normalized.details,
        locale: normalized.locale,
        indicative_price_vnd: price.indicative_price_vnd,
        price_kind: price.price_kind,
        consent_at: new Date().toISOString(),
        consent_version: CONSENT_VERSION,
      })
      .select("id,status,indicative_price_vnd,price_kind")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        const concurrent = await getExistingReceipt(adminClient, normalized.idempotency_key);
        if (concurrent?.request_fingerprint === requestFingerprint) {
          const notificationSent = await deliverAdminNotification(
            adminClient,
            concurrent.id,
            concurrent.service_type,
            concurrent.locale,
          );
          if (!notificationSent) return response(req, { error: "notification_pending", request_id: concurrent.id }, 503);
          return response(req, {
            request_id: concurrent.id,
            status: concurrent.status,
            indicative_price_vnd: concurrent.indicative_price_vnd,
            price_kind: concurrent.price_kind,
          }, 200);
        }
        return response(req, { error: "idempotency_conflict" }, 409);
      }
      throw insertError;
    }

    const notificationSent = await deliverAdminNotification(
      adminClient,
      inserted.id,
      normalized.service_type,
      normalized.locale,
    );
    if (!notificationSent) return response(req, { error: "notification_pending", request_id: inserted.id }, 503);

    return response(req, {
      request_id: inserted.id,
      status: "new",
      indicative_price_vnd: inserted.indicative_price_vnd,
      price_kind: inserted.price_kind,
    }, 201);
  } catch (error) {
    console.error(JSON.stringify({ correlation_id: correlationId, code: "internal_error", stage: "persist" }));
    return response(req, { error: "internal_error" }, 500);
  }
};

serve(handle);
