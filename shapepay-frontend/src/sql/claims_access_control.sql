CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  claims jsonb;
  user_role TEXT;
  merchant_id UUID;
  error_message TEXT;
BEGIN
  claims := event->'claims';

  -- Attempt to retrieve user_role and merchant_id
  BEGIN
    SELECT r.name::TEXT, mu.merchant_id::UUID
    INTO user_role, merchant_id
    FROM public.merchant_users mu
    JOIN public.roles r ON mu.role_id = r.id
    WHERE mu.user_id = (event->>'user_id')::uuid
    ORDER BY mu.merchant_id
    LIMIT 1;

    -- If no role found, set a default message
    IF user_role IS NULL THEN
      user_role := 'No role assigned';
    END IF;

    IF merchant_id IS NULL THEN
      merchant_id := NULL::uuid;
    END IF;

  EXCEPTION
    WHEN OTHERS THEN
      -- Capture the error message
      error_message := 'Error: ' || SQLERRM;
  END;

  -- Set the claims
  claims := jsonb_set(claims, '{user_role}', COALESCE(to_jsonb(user_role), 'null'::jsonb));
  claims := jsonb_set(claims, '{merchant_id}', COALESCE(to_jsonb(merchant_id::text), 'null'::jsonb));
  
  -- Only set error_message if there was an error
  IF error_message IS NOT NULL THEN
    claims := jsonb_set(claims, '{error_message}', to_jsonb(error_message));
  END IF;

  -- Update the 'claims' object in the original event
  event := jsonb_set(event, '{claims}', claims);

  -- Return the modified event
  RETURN event;
END;
$$;

-- Grant necessary permissions
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;

REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM authenticated, anon, public;

-- Grant SELECT permissions on necessary tables
GRANT SELECT ON public.profiles TO supabase_auth_admin;
GRANT SELECT ON public.merchant_users TO supabase_auth_admin;
GRANT SELECT ON public.roles TO supabase_auth_admin;

-- Function to get the current user's role
CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS TEXT AS $$
BEGIN
    RETURN (auth.jwt() ->> 'role');
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Function to get the current user's merchant_id
CREATE OR REPLACE FUNCTION public.get_user_merchant_id()
RETURNS UUID AS $$
BEGIN
    RETURN (auth.jwt() ->> 'merchant_id')::UUID;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
