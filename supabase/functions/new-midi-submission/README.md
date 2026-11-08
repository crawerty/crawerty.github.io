# New MIDI submission notification

This Supabase Edge Function sends an email whenever a row is inserted into
`public.midi_files`.

## Set the secrets

Create a Resend API key and verify the sender domain first. Then run the
following commands from this repository after linking the Supabase project:

```sh
supabase secrets set \
  RESEND_API_KEY="your_resend_api_key" \
  NOTIFICATION_TO_EMAIL="onsightpracticestudio@gmail.com" \
  NOTIFICATION_FROM_EMAIL="OnSight Music <submissions@your-verified-domain.com>"
```

## Deploy

```sh
supabase functions deploy new-midi-submission --no-verify-jwt
```

## Create the database webhook

In the Supabase Dashboard, create a Database Webhook with these settings:

- Name: `email-on-midi-submission`
- Table: `public.midi_files`
- Event: `INSERT`
- Type: `Supabase Edge Function`
- Edge Function: `new-midi-submission`
- HTTP header: use **Add secret key**

Submit a MIDI file through the Community MIDI page to test it. The function
appears in the Supabase Edge Function logs and webhook delivery history.
