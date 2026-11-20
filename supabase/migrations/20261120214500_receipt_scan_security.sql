-- Receipt scan quotas and audit logs.
-- Counters are mutated only by check_and_increment_scan_quota, which is
-- SECURITY DEFINER and executable only by service_role. RLS is on and there
-- are no policies for anon or authenticated, so the client cannot read or
-- write these tables.

CREATE TABLE public.receipt_scan_rate_limits (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  window_type text NOT NULL CHECK (window_type IN ('hourly', 'daily')),
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, window_type, window_start)
);

CREATE TABLE public.receipt_scan_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('success', 'rate_limited', 'invalid_payload', 'upstream_error', 'timeout')),
  model text,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX receipt_scan_audit_logs_user_created_idx
  ON public.receipt_scan_audit_logs (user_id, created_at DESC);

ALTER TABLE public.receipt_scan_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_scan_audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.receipt_scan_rate_limits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.receipt_scan_audit_logs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.receipt_scan_rate_limits TO service_role;
GRANT ALL ON TABLE public.receipt_scan_audit_logs TO service_role;

-- Locks the hourly row, then the daily row, in that order.
-- INSERT ... ON CONFLICT DO UPDATE takes the row lock that SELECT FOR UPDATE
-- would take, and also creates the window row on the first request.
-- A second transaction blocks on the same key until this one commits, so the
-- limit check and the increment cannot interleave.
CREATE OR REPLACE FUNCTION public.check_and_increment_scan_quota(
  p_user_id uuid,
  p_hourly_limit integer DEFAULT 10,
  p_daily_limit integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hour_start timestamptz;
  v_day_start timestamptz;
  v_hourly_count integer;
  v_daily_count integer;
  v_retry integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required' USING ERRCODE = '22023';
  END IF;

  IF p_hourly_limit IS NULL OR p_hourly_limit < 1 OR p_daily_limit IS NULL OR p_daily_limit < 1 THEN
    RAISE EXCEPTION 'quota limits must be positive' USING ERRCODE = '22023';
  END IF;

  v_hour_start := date_trunc('hour', now());
  v_day_start := date_trunc('day', now());

  INSERT INTO public.receipt_scan_rate_limits AS limits (user_id, window_type, window_start, request_count)
  VALUES (p_user_id, 'hourly', v_hour_start, 0)
  ON CONFLICT (user_id, window_type, window_start)
  DO UPDATE SET updated_at = now()
  RETURNING limits.request_count INTO v_hourly_count;

  INSERT INTO public.receipt_scan_rate_limits AS limits (user_id, window_type, window_start, request_count)
  VALUES (p_user_id, 'daily', v_day_start, 0)
  ON CONFLICT (user_id, window_type, window_start)
  DO UPDATE SET updated_at = now()
  RETURNING limits.request_count INTO v_daily_count;

  IF v_hourly_count >= p_hourly_limit THEN
    v_retry := GREATEST(0, extract(epoch FROM (v_hour_start + interval '1 hour' - now()))::int);
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'hourly_limit_exceeded',
      'retry_after_seconds', v_retry,
      'hourly_remaining', 0,
      'daily_remaining', GREATEST(0, p_daily_limit - v_daily_count)
    );
  END IF;

  IF v_daily_count >= p_daily_limit THEN
    v_retry := GREATEST(0, extract(epoch FROM (v_day_start + interval '1 day' - now()))::int);
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'daily_limit_exceeded',
      'retry_after_seconds', v_retry,
      'hourly_remaining', GREATEST(0, p_hourly_limit - v_hourly_count),
      'daily_remaining', 0
    );
  END IF;

  UPDATE public.receipt_scan_rate_limits
  SET request_count = request_count + 1,
      updated_at = now()
  WHERE user_id = p_user_id
    AND window_type = 'hourly'
    AND window_start = v_hour_start;

  UPDATE public.receipt_scan_rate_limits
  SET request_count = request_count + 1,
      updated_at = now()
  WHERE user_id = p_user_id
    AND window_type = 'daily'
    AND window_start = v_day_start;

  RETURN jsonb_build_object(
    'allowed', true,
    'reason', NULL,
    'retry_after_seconds', 0,
    'hourly_remaining', p_hourly_limit - (v_hourly_count + 1),
    'daily_remaining', p_daily_limit - (v_daily_count + 1)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_increment_scan_quota(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_and_increment_scan_quota(uuid, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.check_and_increment_scan_quota(uuid, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_and_increment_scan_quota(uuid, integer, integer) TO service_role;
