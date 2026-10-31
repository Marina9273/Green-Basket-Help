# Green Basket Concierge

This is a standalone Concierge website. It lives outside the Green Basket application repository and is designed for its own Vercel project and its own Supabase project.

The app does not use Green Basket product, order, cart, delivery, or financial data. Its Supabase client has no Green Basket URL or key fallback. The included request migration and Edge Function are for a dedicated Concierge database only.

## Local preview

1. Copy `.env.example` to `.env.local` and add the **new Concierge Supabase project's** URL and anon key.
2. Run `npm run dev`.
3. Open `http://127.0.0.1:8090/`.

Without a configured Concierge project, the page still renders with the approved price fallbacks, but request submission and database-backed price lookup are unavailable.

## Supabase setup

Create a separate Supabase project in the Singapore region. Apply `supabase/migrations/20261017190000_help_service.sql`, deploy `create-help-service-request`, and set the server-only variables listed in `supabase/secrets.example`. Use only this project's URL, anon key, and function deployment.

For admin access, create an Auth user in this project. In the Supabase SQL Editor, grant that user the server-controlled role claim using the user's UUID from Authentication → Users:

```sql
UPDATE auth.users
SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('role', 'concierge_admin')
WHERE id = 'REPLACE_WITH_ADMIN_USER_UUID';
```

The admin page is `/admin`. Its list and update RPCs verify this claim in the database, and the request tables have no direct client access. Sign out and back in after changing the claim so the session receives the updated token.

## Hosting setup

Deploy this directory as a new Vercel project on the account's Hobby plan. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from the separate Concierge Supabase project in the Vercel project environment. The Vercel rewrite serves the React app at `/admin` as well as `/`.

Attach `concierge.green-basket.online` to the new Vercel project. Use the exact CNAME target Vercel provides and add only a `concierge` CNAME record in Porkbun; leave the existing apex and `www` records unchanged. The Concierge site and its database are independent from the Green Basket application.
