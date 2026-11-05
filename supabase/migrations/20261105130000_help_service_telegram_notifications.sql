ALTER TABLE public.help_service_notification_outbox
  DROP CONSTRAINT IF EXISTS help_service_notification_outbox_status_check;

ALTER TABLE public.help_service_notification_outbox
  ADD CONSTRAINT help_service_notification_outbox_status_check
  CHECK (status IN ('pending', 'sending', 'sent'));

COMMENT ON TABLE public.help_service_notification_outbox IS
  'Tracks Telegram notification delivery without storing applicant contact details or message bodies.';

COMMENT ON COLUMN public.help_service_notification_outbox.provider_message_id IS
  'Telegram message identifier returned by the Bot API.';
