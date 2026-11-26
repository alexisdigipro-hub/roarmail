-- RoarMail Live (live/, Cloudflare): the key it shares with the Edge Function roarmail-creds lives in Vault as
-- 'roarmail_live_key' (made once by hand with vault.create_secret, never written here); only the service role reads it.
create or replace function public.roarmail_live_key() returns text language sql security definer set search_path = '' as
$$ select decrypted_secret from vault.decrypted_secrets where name = 'roarmail_live_key' limit 1 $$;
revoke all on function public.roarmail_live_key() from public, anon, authenticated;
grant execute on function public.roarmail_live_key() to service_role;
