ALTER TABLE public.managers_auth
    ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

ALTER TABLE public.personal_agent_records
    DROP CONSTRAINT IF EXISTS personal_agent_records_currency;

ALTER TABLE public.personal_agent_records
    ADD CONSTRAINT personal_agent_records_currency CHECK (currency = 'KZT');

CREATE OR REPLACE FUNCTION public.personal_agent_finance_summary(
    p_agent_id uuid,
    p_from timestamptz DEFAULT NULL,
    p_to timestamptz DEFAULT NULL
)
RETURNS TABLE(currency text, expense numeric, income numeric, entry_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT
        records.currency,
        COALESCE(sum(records.amount) FILTER (WHERE records.transaction_type = 'expense'), 0)::numeric AS expense,
        COALESCE(sum(records.amount) FILTER (WHERE records.transaction_type = 'income'), 0)::numeric AS income,
        count(*)::bigint AS entry_count
    FROM public.personal_agent_records AS records
    WHERE records.agent_id = p_agent_id
      AND records.kind = 'transaction'
      AND records.status <> 'deleted'
      AND (p_from IS NULL OR records.occurred_at >= p_from)
      AND (p_to IS NULL OR records.occurred_at < p_to)
    GROUP BY records.currency;
$$;

REVOKE ALL ON FUNCTION public.personal_agent_finance_summary(uuid, timestamptz, timestamptz)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.personal_agent_finance_summary(uuid, timestamptz, timestamptz)
    TO service_role;
