-- Live provider connections feeding the provider-independent bank transaction model.
-- Provider credentials are encrypted by the application before they reach Supabase.

CREATE TABLE IF NOT EXISTS public.bank_provider_connections (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                 TEXT NOT NULL CHECK (provider IN ('plaid')),
  provider_item_id         TEXT NOT NULL,
  access_token_encrypted   TEXT,
  institution_id           TEXT,
  institution_name         TEXT NOT NULL DEFAULT 'Unknown institution',
  connection_status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (connection_status IN ('pending', 'healthy', 'syncing', 'degraded', 'relogin_required', 'disconnected')),
  sync_cursor              TEXT,
  sync_lock_token          UUID,
  sync_lock_until          TIMESTAMPTZ,
  consent_expiration_time  TIMESTAMPTZ,
  last_successful_sync_at  TIMESTAMPTZ,
  last_webhook_at          TIMESTAMPTZ,
  last_error_code          TEXT,
  last_error_message       TEXT,
  connected_by             TEXT NOT NULL,
  connected_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at          TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_item_id)
);

ALTER TABLE public.bank_provider_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full_access" ON public.bank_provider_connections;
CREATE POLICY "service_role_full_access"
  ON public.bank_provider_connections FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.bank_provider_accounts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id            UUID NOT NULL REFERENCES public.bank_provider_connections(id) ON DELETE CASCADE,
  provider_account_id      TEXT NOT NULL,
  persistent_account_id    TEXT,
  account_name             TEXT NOT NULL,
  official_name            TEXT,
  mask                     TEXT,
  account_type             TEXT,
  account_subtype          TEXT,
  enabled                  BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, provider_account_id)
);

ALTER TABLE public.bank_provider_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full_access" ON public.bank_provider_accounts;
CREATE POLICY "service_role_full_access"
  ON public.bank_provider_accounts FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS bank_provider_connections_updated_at ON public.bank_provider_connections;
CREATE TRIGGER bank_provider_connections_updated_at
  BEFORE UPDATE ON public.bank_provider_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_bank_reconciliation_updated_at();

DROP TRIGGER IF EXISTS bank_provider_accounts_updated_at ON public.bank_provider_accounts;
CREATE TRIGGER bank_provider_accounts_updated_at
  BEFORE UPDATE ON public.bank_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_bank_reconciliation_updated_at();

-- A short database lease prevents duplicate webhooks/manual syncs from running
-- /transactions/sync concurrently for the same Item.
CREATE OR REPLACE FUNCTION public.claim_bank_provider_sync(
  p_connection_id UUID,
  p_lock_token UUID,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed UUID;
BEGIN
  UPDATE public.bank_provider_connections
  SET sync_lock_token = p_lock_token,
      sync_lock_until = now() + make_interval(secs => GREATEST(30, LEAST(p_lease_seconds, 600))),
      connection_status = 'syncing'
  WHERE id = p_connection_id
    AND connection_status <> 'disconnected'
    AND access_token_encrypted IS NOT NULL
    AND (sync_lock_until IS NULL OR sync_lock_until < now())
  RETURNING id INTO v_claimed;
  RETURN v_claimed IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_bank_provider_sync(
  p_connection_id UUID,
  p_lock_token UUID,
  p_cursor TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated UUID;
BEGIN
  UPDATE public.bank_provider_connections
  SET sync_cursor = p_cursor,
      sync_lock_until = now() + interval '600 seconds'
  WHERE id = p_connection_id AND sync_lock_token = p_lock_token
  RETURNING id INTO v_updated;
  RETURN v_updated IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_bank_provider_sync(
  p_connection_id UUID,
  p_lock_token UUID,
  p_status TEXT,
  p_error_code TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated UUID;
BEGIN
  IF p_status NOT IN ('healthy', 'degraded', 'relogin_required') THEN
    RAISE EXCEPTION 'Invalid provider connection finish status: %', p_status;
  END IF;
  UPDATE public.bank_provider_connections
  SET connection_status = p_status,
      sync_lock_token = NULL,
      sync_lock_until = NULL,
      last_successful_sync_at = CASE WHEN p_status = 'healthy' THEN now() ELSE last_successful_sync_at END,
      last_error_code = p_error_code,
      last_error_message = p_error_message
  WHERE id = p_connection_id AND sync_lock_token = p_lock_token
  RETURNING id INTO v_updated;
  RETURN v_updated IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_bank_provider_sync(UUID, UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.advance_bank_provider_sync(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_bank_provider_sync(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_bank_provider_sync(UUID, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.advance_bank_provider_sync(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_bank_provider_sync(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
