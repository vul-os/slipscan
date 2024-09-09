
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '"public", "extensions"', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";

CREATE EXTENSION IF NOT EXISTS "pgsodium" WITH SCHEMA "pgsodium";

COMMENT ON SCHEMA "public" IS 'standard public schema';

CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";

CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pgjwt" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

CREATE OR REPLACE FUNCTION "public"."accept_merchant_invitation"(p_token text) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_invitation merchant_invitations%ROWTYPE;
    v_user_id UUID;
    v_role_id UUID;
BEGIN
    -- Find and lock the invitation
    SELECT * INTO v_invitation
    FROM merchant_invitations
    WHERE token = p_token AND expires_at > CURRENT_TIMESTAMP
    FOR UPDATE;
    
    IF v_invitation IS NULL THEN
        RETURN FALSE; -- Invalid or expired token
    END IF;
    
    -- Get the user ID (assuming the user has registered by this point)
    SELECT id INTO v_user_id FROM auth.users WHERE email = v_invitation.email;
    
    IF v_user_id IS NULL THEN
        RETURN FALSE; -- User not found
    END IF;
    
    -- Get the role ID
    SELECT id INTO v_role_id FROM roles WHERE name = v_invitation.role_name;
    
    IF v_role_id IS NULL THEN
        RAISE EXCEPTION 'Role % not found', v_invitation.role_name;
    END IF;

    -- Add the user to the merchant with the specified role
    INSERT INTO merchant_users (merchant_id, user_id, role_id)
    VALUES (v_invitation.merchant_id, v_user_id, v_role_id)
    ON CONFLICT (merchant_id, user_id) DO UPDATE
    SET role_id = EXCLUDED.role_id;
    
    -- Delete the invitation
    DELETE FROM merchant_invitations WHERE id = v_invitation.id;
    
    RETURN TRUE;
END;
$$;

ALTER FUNCTION "public"."accept_merchant_invitation"(p_token text) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."create_customer_session"(p_customer_id uuid, p_duration interval DEFAULT '24:00:00'::interval) RETURNS TABLE(token text)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_token TEXT;
BEGIN
    -- Generate a secure token
    v_token := generate_secure_token();
    
    -- Insert the new session
    INSERT INTO customer_sessions (customer_id, token, expires_at)
    VALUES (p_customer_id, v_token, CURRENT_TIMESTAMP + p_duration);
    
    RETURN QUERY SELECT v_token;
END;
$$;

ALTER FUNCTION "public"."create_customer_session"(p_customer_id uuid, p_duration interval) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."create_simple_payment"(p_merchant_id uuid, p_customer_name text, p_customer_email text, p_customer_phone text, p_total_amount numeric, p_currency text DEFAULT 'ZAR'::text, p_payment_method text DEFAULT 'PayShap'::text) RETURNS TABLE(payment_group_id uuid, payment_id uuid, customer_id uuid, payment_code text)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_customer_id UUID;
    v_payment_group_id UUID;
    v_payment_id UUID;
    v_auth_uid UUID;
    v_payment_code TEXT;
    v_payment_code_id UUID;
    v_default_phone TEXT := 'UNKNOWN';
BEGIN
    -- Get the authenticated user ID if available
    v_auth_uid := auth.uid();
    
    -- Step 1: Create or fetch the customer
    IF v_auth_uid IS NOT NULL THEN
        -- Authenticated user
        SELECT id INTO v_customer_id
        FROM customers
        WHERE user_id = v_auth_uid;
        
        IF v_customer_id IS NULL THEN
            -- Create a new customer record for the authenticated user
            INSERT INTO customers (user_id, name, email, phone)
            VALUES (v_auth_uid, 
                    COALESCE(NULLIF(p_customer_name, ''), 'Anonymous'),
                    NULLIF(p_customer_email, ''),
                    COALESCE(NULLIF(p_customer_phone, ''), v_default_phone))
            RETURNING id INTO v_customer_id;
        ELSE
            -- Update existing customer information if it has changed and is not null or empty
            UPDATE customers
            SET name = COALESCE(NULLIF(p_customer_name, ''), name),
                email = COALESCE(NULLIF(p_customer_email, ''), email),
                phone = COALESCE(NULLIF(p_customer_phone, ''), phone)
            WHERE id = v_customer_id;
        END IF;
    ELSE
        -- Anonymous user
        IF p_customer_email IS NOT NULL AND p_customer_email != '' THEN
            -- Try to find an existing customer with the given email
            SELECT id INTO v_customer_id
            FROM customers
            WHERE email = p_customer_email;
            
            IF v_customer_id IS NULL THEN
                -- Create a new customer if not found
                INSERT INTO customers (name, email, phone)
                VALUES (COALESCE(NULLIF(p_customer_name, ''), 'Anonymous'),
                        p_customer_email,
                        COALESCE(NULLIF(p_customer_phone, ''), v_default_phone))
                RETURNING id INTO v_customer_id;
            ELSE
                -- Update existing customer information
                UPDATE customers
                SET name = COALESCE(NULLIF(p_customer_name, ''), name),
                    phone = COALESCE(NULLIF(p_customer_phone, ''), phone)
                WHERE id = v_customer_id;
            END IF;
        ELSE
            -- Use an existing anonymous customer or create a new one if none exists
            SELECT id INTO v_customer_id
            FROM customers
            WHERE name = 'Anonymous' AND email IS NULL AND phone = v_default_phone AND user_id IS NULL
            LIMIT 1;
            
            IF v_customer_id IS NULL THEN
                -- Create a new anonymous customer if none exists
                INSERT INTO customers (name, email, phone)
                VALUES ('Anonymous', NULL, v_default_phone)
                RETURNING id INTO v_customer_id;
            END IF;
        END IF;
    END IF;
    
    -- Ensure the customer is associated with the merchant
    INSERT INTO customer_merchants (customer_id, merchant_id)
    VALUES (v_customer_id, p_merchant_id)
    ON CONFLICT DO NOTHING;
    
    -- Create a new payment group with status 'pending'
    INSERT INTO payment_groups (customer_id, total_amount, merchant_id, status)
    VALUES (v_customer_id, p_total_amount, p_merchant_id, 'pending')
    RETURNING id INTO v_payment_group_id;
    
    -- Create a new payment with status 'pending'
    INSERT INTO payments (payment_group_id, amount_charged, status, payment_method, customer_id)
    VALUES (v_payment_group_id, p_total_amount, 'pending', p_payment_method, v_customer_id)
    RETURNING id INTO v_payment_id;
    
    -- Generate a new unique payment code
    v_payment_code := find_unique_payment_code();
    
    -- The payment code is already inserted in payment_code_definitions, so we just need to link it
    SELECT id INTO v_payment_code_id
    FROM payment_code_definitions
    WHERE code = v_payment_code;
    
    -- Link the payment code to the payment
    INSERT INTO payment_codes (code_id, payment_id)
    VALUES (v_payment_code_id, v_payment_id);
    
    -- Return the payment ID, session token, customer ID, and new payment code
    RETURN QUERY SELECT v_payment_group_id, v_payment_id, v_customer_id, v_payment_code;
EXCEPTION
    WHEN others THEN
        -- If an error occurs, attempt to deactivate the payment code
        IF v_payment_code IS NOT NULL THEN
            UPDATE payment_code_definitions SET status = 'inactive' WHERE code = v_payment_code;
        END IF;
        RAISE;
END;
$$;

ALTER FUNCTION "public"."create_simple_payment"(p_merchant_id uuid, p_customer_name text, p_customer_email text, p_customer_phone text, p_total_amount numeric, p_currency text, p_payment_method text) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."custom_access_token_hook"(event jsonb) RETURNS jsonb
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
DECLARE
  claims jsonb;
  user_merchants jsonb;
  error_message TEXT;
BEGIN
  claims := event->'claims';

  -- Retrieve all merchant_ids and roles for the user
  BEGIN
    SELECT jsonb_agg(jsonb_build_object('merchantId', mu.merchant_id::text, 'role', r.name::text))
    INTO user_merchants
    FROM public.merchant_users mu
    JOIN public.roles r ON mu.role_id = r.id
    WHERE mu.user_id = (event->>'user_id')::uuid;

    IF user_merchants IS NULL THEN
      user_merchants := '[]'::jsonb;
    END IF;

  EXCEPTION
    WHEN OTHERS THEN
      error_message := 'Error: ' || SQLERRM;
      user_merchants := '[]'::jsonb;
  END;

  -- Set the claims
  claims := jsonb_set(claims, '{user_merchants}', user_merchants);
  
  IF error_message IS NOT NULL THEN
    claims := jsonb_set(claims, '{error_message}', to_jsonb(error_message));
  END IF;

  event := jsonb_set(event, '{claims}', claims);

  RETURN event;
END;
$$;

ALTER FUNCTION "public"."custom_access_token_hook"(event jsonb) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."find_unique_payment_code"() RETURNS text
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    unique_code TEXT;
    max_attempts INTEGER := 50; -- Increased maximum number of attempts
    attempt INTEGER := 0;
BEGIN
    WHILE attempt < max_attempts LOOP
        -- Generate a new random code
        unique_code := upper(substring(md5(random()::text) from 1 for 6));
        
        -- Check if this code already exists
        IF NOT EXISTS (SELECT 1 FROM payment_code_definitions WHERE code = unique_code) THEN
            -- Attempt to insert the new code
            BEGIN
                INSERT INTO payment_code_definitions (code, status, expires_at)
                VALUES (unique_code, 'active', CURRENT_TIMESTAMP + INTERVAL '24 hours');
                
                -- If successful, return the code
                RETURN unique_code;
            EXCEPTION WHEN unique_violation THEN
                -- If a concurrent insert occurred, try again
            END;
        END IF;

        attempt := attempt + 1;
    END LOOP;

    -- If we've reached this point, we couldn't generate a unique code
    RAISE EXCEPTION 'Unable to generate a unique payment code after % attempts', max_attempts;
END;
$$;

ALTER FUNCTION "public"."find_unique_payment_code"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."generate_invitation_token"() RETURNS text
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    RETURN encode(gen_random_bytes(32), 'hex');
END;
$$;

ALTER FUNCTION "public"."generate_invitation_token"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."generate_payment_codes"(num_codes integer) RETURNS void
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    new_code TEXT;
    attempt INTEGER;
BEGIN
    FOR i IN 1..num_codes LOOP
        attempt := 0;
        LOOP
            -- Generate a random 6-character code
            new_code := upper(substring(md5(random()::text) from 1 for 6));
            
            -- Try to insert the new code
            BEGIN
                INSERT INTO payment_code_definitions (code, status, expires_at)
                VALUES (new_code, 'inactive', CURRENT_TIMESTAMP + INTERVAL '1 day');
                
                -- If successful, exit the loop
                EXIT;
            EXCEPTION WHEN unique_violation THEN
                -- If a duplicate code is generated, try again
                attempt := attempt + 1;
                IF attempt > 10 THEN
                    RAISE EXCEPTION 'Failed to generate a unique code after 10 attempts';
                END IF;
            END;
        END LOOP;
    END LOOP;
END;
$$;

ALTER FUNCTION "public"."generate_payment_codes"(num_codes integer) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."generate_secure_token"() RETURNS text
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    token TEXT;
BEGIN
    -- Generate a random UUID and hash it
    token := encode(digest(gen_random_uuid()::text, 'sha256'), 'hex');
    RETURN token;
END;
$$;

ALTER FUNCTION "public"."generate_secure_token"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_current_customer_id"() RETURNS uuid
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_token TEXT;
    v_customer_id UUID;
BEGIN
    v_token := current_setting('request.headers', true)::json->>'x-customer-token';
    
    IF v_token IS NOT NULL THEN
        v_customer_id := validate_customer_session(v_token);
    END IF;

    RETURN v_customer_id;
END;
$$;

ALTER FUNCTION "public"."get_current_customer_id"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_merchant"(p_merchant_handle text) RETURNS TABLE(id uuid, name text, email text, phone text, handle text, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    RETURN QUERY
    SELECT m.id, m.name, m.email, m.phone, m.handle, m.created_at, m.updated_at
    FROM merchants m
    WHERE m.handle = p_merchant_handle;
END;
$$;

ALTER FUNCTION "public"."get_merchant"(p_merchant_handle text) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_merchant_daily_revenue_and_payout"(p_merchant_id uuid, p_start_date date, p_end_date date) RETURNS TABLE(date date, total_amount numeric, payout_amount numeric)
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    DATE(p.created_at) AS date,
    SUM(p.amount_collected)::NUMERIC(10,2) AS total_amount,
    COALESCE(SUM(py.amount), 0)::NUMERIC(10,2) AS payout_amount
  FROM
    payments p
    JOIN payment_groups pg ON p.payment_group_id = pg.id
    LEFT JOIN payouts py ON py.merchant_id = pg.merchant_id AND DATE(py.created_at) = DATE(p.created_at)
  WHERE
    pg.merchant_id = p_merchant_id
    AND p.status = 'completed'
    AND DATE(p.created_at) >= p_start_date
    AND DATE(p.created_at) <= p_end_date
  GROUP BY
    DATE(p.created_at)
  ORDER BY
    DATE(p.created_at);
END;
$$;

ALTER FUNCTION "public"."get_merchant_daily_revenue_and_payout"(p_merchant_id uuid, p_start_date date, p_end_date date) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_merchant_total_fees"(p_merchant_id uuid, p_start_date date, p_end_date date) RETURNS TABLE(total_fees numeric, total_transactions bigint, avg_fee_per_transaction numeric)
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    SUM(tf.fee_amount)::NUMERIC(10,2) AS total_fees,
    COUNT(DISTINCT tf.txn_id)::BIGINT AS total_transactions,
    (SUM(tf.fee_amount) / COUNT(DISTINCT tf.txn_id))::NUMERIC(10,2) AS avg_fee_per_transaction
  FROM transaction_fees tf
  JOIN txns t ON tf.txn_id = t.id
  WHERE t.merchant_id = p_merchant_id
    AND DATE(t.created_at) BETWEEN p_start_date AND p_end_date
    AND t.status = 'completed';
END;
$$;

ALTER FUNCTION "public"."get_merchant_total_fees"(p_merchant_id uuid, p_start_date date, p_end_date date) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_or_invite_user"(p_merchant_id uuid, p_email text, p_role_name text) RETURNS TABLE(return_user_id uuid, is_new boolean, invitation_token text)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_user_id UUID;
    v_role_id UUID;
    v_token TEXT;
BEGIN
    -- Get the role ID for the provided role name
    SELECT id INTO v_role_id FROM roles WHERE name = p_role_name;
    IF v_role_id IS NULL THEN
        RAISE EXCEPTION 'Role % not found', p_role_name;
    END IF;

    -- Check if the user already exists
    SELECT id INTO v_user_id FROM auth.users WHERE email = p_email;
    
    IF v_user_id IS NOT NULL THEN
        -- User exists, insert into merchant_users if not already present
        INSERT INTO merchant_users (merchant_id, user_id, role_id)
        VALUES (p_merchant_id, v_user_id, v_role_id)
        ON CONFLICT (merchant_id, user_id) DO UPDATE
        SET role_id = EXCLUDED.role_id;
        
        RETURN QUERY 
        SELECT 
            v_user_id AS return_user_id, 
            FALSE AS is_new, 
            NULL::TEXT AS invitation_token;
    ELSE
        -- User doesn't exist, create an invitation
        v_token := generate_invitation_token();
        
        INSERT INTO merchant_invitations (merchant_id, email, role_name, token, expires_at)
        VALUES (p_merchant_id, p_email, p_role_name, v_token, CURRENT_TIMESTAMP + INTERVAL '7 days')
        ON CONFLICT (merchant_id, email) DO UPDATE
        SET role_name = EXCLUDED.role_name,
            token = EXCLUDED.token,
            expires_at = EXCLUDED.expires_at;
        
        RETURN QUERY 
        SELECT 
            NULL::UUID AS return_user_id, 
            TRUE AS is_new, 
            v_token AS invitation_token;
    END IF;
END;
$$;

ALTER FUNCTION "public"."get_or_invite_user"(p_merchant_id uuid, p_email text, p_role_name text) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_payment_group_details"(payment_group_id uuid) RETURNS TABLE(status text, total_amount numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT pg.status, pg.total_amount
  FROM payment_groups pg
  WHERE pg.id = payment_group_id;
END;
$$;

ALTER FUNCTION "public"."get_payment_group_details"(payment_group_id uuid) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_recent_transactions"(p_merchant_id uuid, p_limit_num integer) RETURNS TABLE(transaction_id uuid, date date, amount numeric, status text)
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    t.id AS transaction_id,
    DATE(t.created_at) as date,
    t.total_amount AS amount,
    t.status
  FROM txns t
  WHERE t.merchant_id = p_merchant_id
  ORDER BY t.created_at DESC
  LIMIT p_limit_num;
END;
$$;

ALTER FUNCTION "public"."get_recent_transactions"(p_merchant_id uuid, p_limit_num integer) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_top_customers"(p_merchant_id uuid, p_start_date date, p_end_date date, p_limit_num integer) RETURNS TABLE(customer_id uuid, customer_name text, total_spent numeric)
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    c.id AS customer_id,
    c.name AS customer_name,
    SUM(p.amount_collected)::NUMERIC(10,2) AS total_spent
  FROM payments p
  JOIN payment_groups pg ON p.payment_group_id = pg.id
  JOIN customers c ON p.customer_id = c.id
  WHERE pg.merchant_id = p_merchant_id
    AND DATE(p.created_at) BETWEEN p_start_date AND p_end_date
    AND p.status = 'completed'
  GROUP BY c.id, c.name
  ORDER BY total_spent DESC
  LIMIT p_limit_num;
END;
$$;

ALTER FUNCTION "public"."get_top_customers"(p_merchant_id uuid, p_start_date date, p_end_date date, p_limit_num integer) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_transaction_stats"(p_merchant_id uuid, p_start_date date, p_end_date date) RETURNS TABLE(total_transactions bigint, successful_transactions bigint, success_rate numeric, total_revenue numeric, avg_transaction_value numeric, total_fees numeric, avg_fee_per_transaction numeric)
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*)::BIGINT AS total_transactions,
    COUNT(*) FILTER (WHERE t.status = 'completed')::BIGINT AS successful_transactions,
    (COUNT(*) FILTER (WHERE t.status = 'completed')::NUMERIC / COUNT(*)::NUMERIC * 100)::NUMERIC(5,2) AS success_rate,
    SUM(t.total_amount)::NUMERIC(10,2) AS total_revenue,
    (SUM(t.total_amount) / COUNT(*))::NUMERIC(10,2) AS avg_transaction_value,
    COALESCE(SUM(tf.fee_amount), 0)::NUMERIC(10,2) AS total_fees,
    (COALESCE(SUM(tf.fee_amount), 0) / COUNT(*))::NUMERIC(10,2) AS avg_fee_per_transaction
  FROM txns t
  LEFT JOIN transaction_fees tf ON t.id = tf.txn_id
  WHERE t.merchant_id = p_merchant_id
    AND DATE(t.created_at) BETWEEN p_start_date AND p_end_date;
END;
$$;

ALTER FUNCTION "public"."get_transaction_stats"(p_merchant_id uuid, p_start_date date, p_end_date date) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_user_merchant_id"() RETURNS uuid
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
BEGIN
    RETURN (auth.jwt() ->> 'merchant_id')::UUID;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$;

ALTER FUNCTION "public"."get_user_merchant_id"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_user_merchants_and_roles"() RETURNS jsonb
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
BEGIN
    RETURN (auth.jwt() ->> 'user_merchants')::jsonb;
EXCEPTION
    WHEN OTHERS THEN
        RETURN '[]'::jsonb;
END;
$$;

ALTER FUNCTION "public"."get_user_merchants_and_roles"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_user_role"() RETURNS text
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
BEGIN
    RETURN (auth.jwt() ->> 'role');
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$;

ALTER FUNCTION "public"."get_user_role"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."get_user_role_for_merchant"(merchant_id uuid) RETURNS text
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
DECLARE
  user_merchants jsonb;
  merchant jsonb;
BEGIN
  user_merchants := current_setting('request.jwt.claims', true)::jsonb->'user_merchants';
  
  FOR merchant IN SELECT * FROM jsonb_array_elements(user_merchants)
  LOOP
    IF (merchant->>'merchantId')::uuid = merchant_id THEN
      RETURN merchant->>'role';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

ALTER FUNCTION "public"."get_user_role_for_merchant"(merchant_id uuid) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS trigger
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    INSERT INTO public.profiles (id, full_name, email, avatar_url)
    VALUES (
        new.id, 
        new.raw_user_meta_data->>'full_name', 
        new.email,  -- Retrieve email directly from the new auth.user
        new.raw_user_meta_data->>'avatar_url'
    );
    RETURN new;
END;
$$;

ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."mark_code_inactive"(p_code text) RETURNS void
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    UPDATE payment_code_definitions
    SET status = 'inactive'
    WHERE similarity(code, upper(p_code)) > 0.8 AND status != 'inactive';
END;
$$;

ALTER FUNCTION "public"."mark_code_inactive"(p_code text) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."process_new_bank_transaction"() RETURNS trigger
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_payment_id UUID;
    v_payment_group_id UUID;
    v_merchant_id UUID;
    v_customer_id UUID;
    v_txn_id UUID;
    v_amount DECIMAL(10, 2);
    v_search_value TEXT;
BEGIN
    -- Determine which field to use for searching
    v_search_value := COALESCE(NULLIF(NEW.reference, ''), NEW.description);

    -- Find a matching payment based on the reference or description
    SELECT p.id, p.payment_group_id, pg.merchant_id, pg.customer_id, p.txn_id, p.amount_charged
    INTO v_payment_id, v_payment_group_id, v_merchant_id, v_customer_id, v_txn_id, v_amount
    FROM payments p
    JOIN payment_groups pg ON p.payment_group_id = pg.id
    JOIN payment_codes pc ON pc.payment_id = p.id
    JOIN payment_code_definitions pcd ON pcd.id = pc.code_id
    WHERE pcd.code = v_search_value
    LIMIT 1;

    IF FOUND THEN
        -- Update the payment
        UPDATE payments
        SET status = 'completed',
            amount_collected = NEW.amount,
            bank_transaction_id = NEW.id
        WHERE id = v_payment_id;

        -- Update the payment group
        UPDATE payment_groups
        SET status = 'completed'
        WHERE id = v_payment_group_id;

        -- If amount_charged was 0, update total_amount in payment_group and amount_charged in payment
        IF v_amount = 0 THEN
            UPDATE payment_groups
            SET total_amount = NEW.amount
            WHERE id = v_payment_group_id;

            UPDATE payments
            SET amount_charged = NEW.amount
            WHERE id = v_payment_id;
        END IF;

        -- If txn_id is null, create a new transaction
        IF v_txn_id IS NULL THEN
            INSERT INTO txns (merchant_id, customer_id, txn_number, total_amount, status, type)
            VALUES (v_merchant_id, v_customer_id, v_search_value, NEW.amount, 'completed', 'payment')
            RETURNING id INTO v_txn_id;

            -- Update the payment with the new txn_id
            UPDATE payments
            SET txn_id = v_txn_id
            WHERE id = v_payment_id;
        ELSE
            -- Update existing transaction
            UPDATE txns
            SET status = 'completed',
                total_amount = NEW.amount
            WHERE id = v_txn_id;
        END IF;
    ELSE
        -- If no matching payment is found, add to unmatched_transactions
        INSERT INTO unmatched_transactions (bank_transaction_id, status, notes)
        VALUES (NEW.id, 'unmatched', 'No matching payment found for reference/description: ' || v_search_value);
    END IF;

    RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."process_new_bank_transaction"() OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."use_payment_code"(p_code text, p_payment_id uuid) RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    found_code CHAR(6);
    found_payment_code_id UUID;
BEGIN
    -- Find and update the matching or similar code
    UPDATE payment_code_definitions
    SET status = 'used', last_used_at = CURRENT_TIMESTAMP
    WHERE status = 'active'
    AND similarity(code, upper(p_code)) > 0.8
    AND expires_at > CURRENT_TIMESTAMP
    RETURNING id, code INTO found_payment_code_id, found_code;

    IF found_code IS NOT NULL THEN
        -- Link the payment code to the payment
        INSERT INTO payment_codes (code_id, payment_id)
        VALUES (found_payment_code_id, p_payment_id)
        ON CONFLICT (code_id, payment_id) DO NOTHING;
    END IF;

    RETURN found_code IS NOT NULL;
END;
$$;

ALTER FUNCTION "public"."use_payment_code"(p_code text, p_payment_id uuid) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."user_has_merchant_access"(merchant_id uuid) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.merchant_users mu
    JOIN public.roles r ON mu.role_id = r.id
    WHERE mu.merchant_id = user_has_merchant_access.merchant_id
    AND mu.user_id = auth.uid()
    AND r.name IN ('admin', 'view')
  );
END;
$$;

ALTER FUNCTION "public"."user_has_merchant_access"(merchant_id uuid) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."user_is_admin_for_merchant"(merchant_id uuid) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.merchant_users mu
    JOIN public.roles r ON mu.role_id = r.id
    WHERE mu.merchant_id = user_is_admin_for_merchant.merchant_id
    AND mu.user_id = auth.uid()
    AND r.name = 'admin'
  );
END;
$$;

ALTER FUNCTION "public"."user_is_admin_for_merchant"(merchant_id uuid) OWNER TO "postgres";

CREATE OR REPLACE FUNCTION "public"."validate_customer_session"(p_token text) RETURNS uuid
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    v_customer_id UUID;
BEGIN
    -- Find a valid, non-expired session
    SELECT customer_id INTO v_customer_id
    FROM customer_sessions
    WHERE token = p_token AND expires_at > CURRENT_TIMESTAMP;
    
    -- -- If found, update the expiration time
    -- IF v_customer_id IS NOT NULL THEN
    --     UPDATE customer_sessions
    --     SET expires_at = CURRENT_TIMESTAMP + INTERVAL '24 hours'
    --     WHERE token = p_token;
    -- END IF;
    
    RETURN v_customer_id;
END;
$$;

ALTER FUNCTION "public"."validate_customer_session"(p_token text) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";

CREATE TABLE IF NOT EXISTS "public"."api_keys" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "merchant_id" uuid NOT NULL,
    "key_hash" text NOT NULL,
    "key_salt" text NOT NULL,
    "name" text,
    "is_active" boolean DEFAULT true,
    "expires_at" timestamp with time zone,
    "last_used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."api_keys" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "table_name" text NOT NULL,
    "record_id" uuid NOT NULL,
    "action" text NOT NULL,
    "changed_fields" jsonb,
    "changed_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "changed_by" uuid
);

ALTER TABLE "public"."audit_log" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."bank_account_logins" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "bank_account_id" uuid NOT NULL,
    "encrypted_username" bytea NOT NULL,
    "encrypted_password" bytea NOT NULL,
    "is_running" boolean DEFAULT false,
    "last_activity_time" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."bank_account_logins" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."bank_accounts" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "bank_name" text NOT NULL,
    "account_number" text NOT NULL,
    "account_holder" text NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."bank_accounts" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."bank_transactions" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "bank_account_id" uuid,
    "bank_date" timestamp with time zone NOT NULL,
    "description" text,
    "reference" text NOT NULL,
    "service_fee" numeric(10,2) DEFAULT 0.00,
    "amount" numeric(10,2) NOT NULL,
    "balance" numeric(10,2),
    "detected_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."bank_transactions" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."customer_merchants" (
    "customer_id" uuid NOT NULL,
    "merchant_id" uuid NOT NULL
);

ALTER TABLE "public"."customer_merchants" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."customers" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "phone" text NOT NULL,
    "name" text,
    "email" text,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "user_id" uuid
);

ALTER TABLE "public"."customers" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."merchant_bank_details" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "merchant_id" uuid NOT NULL,
    "account_name" character varying(255) NOT NULL,
    "account_number" character varying(50) NOT NULL,
    "bank_name" character varying(100) NOT NULL,
    "branch_code" character varying(20),
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."merchant_bank_details" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."merchant_fees" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "merchant_id" uuid,
    "fee_percentage" numeric(5,2) NOT NULL,
    "effective_from" timestamp with time zone NOT NULL,
    "effective_to" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."merchant_fees" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."merchant_invitations" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "merchant_id" uuid NOT NULL,
    "email" text NOT NULL,
    "role_name" text NOT NULL,
    "token" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "expires_at" timestamp with time zone NOT NULL
);

ALTER TABLE "public"."merchant_invitations" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."merchant_users" (
    "merchant_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "role_id" uuid
);

ALTER TABLE "public"."merchant_users" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."merchants" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "name" text NOT NULL,
    "email" text NOT NULL,
    "phone" text,
    "handle" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."merchants" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."payment_code_definitions" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "code" text NOT NULL,
    "status" text DEFAULT 'inactive'::text NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" timestamp with time zone,
    "expires_at" timestamp with time zone NOT NULL
);

ALTER TABLE "public"."payment_code_definitions" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."payment_codes" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "payment_id" uuid NOT NULL,
    "code_id" uuid NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."payment_codes" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."payment_groups" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "merchant_id" uuid,
    "customer_id" uuid NOT NULL,
    "total_amount" numeric(10,2) NOT NULL,
    "status" text NOT NULL,
    "external_reference_id" text,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."payment_groups" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "payment_group_id" uuid,
    "txn_id" uuid,
    "payshap_target_id" uuid,
    "payshap_transaction_id" text,
    "amount_charged" numeric(10,2) NOT NULL,
    "amount_collected" numeric(10,2) DEFAULT 0 NOT NULL,
    "amount_refunded" numeric(10,2) DEFAULT 0 NOT NULL,
    "status" text NOT NULL,
    "payment_method" text DEFAULT 'PayShap'::text,
    "bank_transaction_id" uuid,
    "customer_id" uuid,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."payments" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."payouts" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "merchant_id" uuid,
    "amount" numeric(10,2) NOT NULL,
    "status" text NOT NULL,
    "payout_date" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."payouts" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."payshap_targets" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "merchant_id" uuid,
    "account_name" text NOT NULL,
    "account_number" text NOT NULL,
    "bank_name" text NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."payshap_targets" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" uuid NOT NULL,
    "updated_at" timestamp with time zone,
    "username" text,
    "full_name" text,
    "email" text,
    "avatar_url" text,
    "website" text,
    CONSTRAINT "username_length" CHECK ((char_length(username) >= 3))
);

ALTER TABLE "public"."profiles" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."reconciliation_log" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "payment_id" uuid,
    "bank_transaction_id" uuid,
    "reconciliation_date" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "status" text NOT NULL,
    "notes" text
);

ALTER TABLE "public"."reconciliation_log" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."refunds" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "txn_id" uuid,
    "amount" numeric(10,2) NOT NULL,
    "payshap_refund_id" text,
    "status" text NOT NULL,
    "reason" text,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."refunds" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."roles" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "name" character varying(50) NOT NULL
);

ALTER TABLE "public"."roles" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."transaction_fees" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "txn_id" uuid,
    "fee_amount" numeric(10,2) NOT NULL,
    "fee_percentage" numeric(5,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."transaction_fees" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."txns" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "merchant_id" uuid,
    "customer_id" uuid,
    "txn_number" text NOT NULL,
    "total_amount" numeric(10,2) NOT NULL,
    "currency" text DEFAULT 'ZAR'::text,
    "status" text NOT NULL,
    "type" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."txns" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."unmatched_transactions" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "bank_transaction_id" uuid,
    "status" text NOT NULL,
    "notes" text,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."unmatched_transactions" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."webhooks" (
    "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
    "merchant_id" uuid,
    "url" text NOT NULL,
    "event_type" text NOT NULL,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "public"."webhooks" OWNER TO "postgres";

ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_merchant_id_key_hash_key" UNIQUE ("merchant_id", "key_hash");

ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."bank_account_logins"
    ADD CONSTRAINT "bank_account_logins_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_account_number_key" UNIQUE ("account_number");

ALTER TABLE ONLY "public"."bank_accounts"
    ADD CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."customer_merchants"
    ADD CONSTRAINT "customer_merchants_pkey" PRIMARY KEY ("customer_id", "merchant_id");

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_email_key" UNIQUE ("email");

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."merchant_bank_details"
    ADD CONSTRAINT "merchant_bank_details_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."merchant_fees"
    ADD CONSTRAINT "merchant_fees_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."merchant_invitations"
    ADD CONSTRAINT "merchant_invitations_merchant_id_email_key" UNIQUE ("merchant_id", "email");

ALTER TABLE ONLY "public"."merchant_invitations"
    ADD CONSTRAINT "merchant_invitations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."merchant_invitations"
    ADD CONSTRAINT "merchant_invitations_token_key" UNIQUE ("token");

ALTER TABLE ONLY "public"."merchant_users"
    ADD CONSTRAINT "merchant_users_pkey" PRIMARY KEY ("merchant_id", "user_id");

ALTER TABLE ONLY "public"."merchants"
    ADD CONSTRAINT "merchants_email_key" UNIQUE ("email");

ALTER TABLE ONLY "public"."merchants"
    ADD CONSTRAINT "merchants_handle_key" UNIQUE ("handle");

ALTER TABLE ONLY "public"."merchants"
    ADD CONSTRAINT "merchants_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."payment_code_definitions"
    ADD CONSTRAINT "payment_code_definitions_code_key" UNIQUE ("code");

ALTER TABLE ONLY "public"."payment_code_definitions"
    ADD CONSTRAINT "payment_code_definitions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."payment_codes"
    ADD CONSTRAINT "payment_codes_payment_id_code_id_key" UNIQUE ("payment_id", "code_id");

ALTER TABLE ONLY "public"."payment_codes"
    ADD CONSTRAINT "payment_codes_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."payment_groups"
    ADD CONSTRAINT "payment_groups_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_payshap_transaction_id_key" UNIQUE ("payshap_transaction_id");

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."payouts"
    ADD CONSTRAINT "payouts_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."payshap_targets"
    ADD CONSTRAINT "payshap_targets_merchant_id_account_number_key" UNIQUE ("merchant_id", "account_number");

ALTER TABLE ONLY "public"."payshap_targets"
    ADD CONSTRAINT "payshap_targets_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_username_key" UNIQUE ("username");

ALTER TABLE ONLY "public"."reconciliation_log"
    ADD CONSTRAINT "reconciliation_log_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."refunds"
    ADD CONSTRAINT "refunds_payshap_refund_id_key" UNIQUE ("payshap_refund_id");

ALTER TABLE ONLY "public"."refunds"
    ADD CONSTRAINT "refunds_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_name_key" UNIQUE ("name");

ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."transaction_fees"
    ADD CONSTRAINT "transaction_fees_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."txns"
    ADD CONSTRAINT "txns_merchant_id_txn_number_key" UNIQUE ("merchant_id", "txn_number");

ALTER TABLE ONLY "public"."txns"
    ADD CONSTRAINT "txns_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "unique_bank_transaction_comprehensive" UNIQUE ("bank_account_id", "bank_date", "description", "reference", "service_fee", "amount", "balance");

ALTER TABLE ONLY "public"."unmatched_transactions"
    ADD CONSTRAINT "unmatched_transactions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."webhooks"
    ADD CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id");

CREATE INDEX idx_merchant_bank_details_merchant_id ON public.merchant_bank_details USING btree (merchant_id);

CREATE INDEX idx_payment_code_definitions_status_code ON public.payment_code_definitions USING btree (status, code);

CREATE INDEX idx_payment_code_definitions_trgm ON public.payment_code_definitions USING gin (code gin_trgm_ops);

CREATE INDEX idx_payment_codes_payment_id ON public.payment_codes USING btree (payment_id);

CREATE TRIGGER process_bank_transaction_trigger AFTER INSERT ON public.bank_transactions FOR EACH ROW EXECUTE FUNCTION process_new_bank_transaction();

ALTER TABLE ONLY "public"."api_keys"
    ADD CONSTRAINT "api_keys_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_changed_by_fkey" FOREIGN KEY (changed_by) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY "public"."bank_transactions"
    ADD CONSTRAINT "bank_transactions_bank_account_id_fkey" FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."customer_merchants"
    ADD CONSTRAINT "customer_merchants_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."customer_merchants"
    ADD CONSTRAINT "customer_merchants_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "fk_customers_user_id" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY "public"."merchant_bank_details"
    ADD CONSTRAINT "merchant_bank_details_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."merchant_fees"
    ADD CONSTRAINT "merchant_fees_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."merchant_invitations"
    ADD CONSTRAINT "merchant_invitations_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES merchants(id);

ALTER TABLE ONLY "public"."merchant_users"
    ADD CONSTRAINT "merchant_users_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES merchants(id);

ALTER TABLE ONLY "public"."merchant_users"
    ADD CONSTRAINT "merchant_users_role_id_fkey" FOREIGN KEY (role_id) REFERENCES roles(id);

ALTER TABLE ONLY "public"."merchant_users"
    ADD CONSTRAINT "merchant_users_user_id_fkey" FOREIGN KEY (user_id) REFERENCES profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."payment_codes"
    ADD CONSTRAINT "payment_codes_code_id_fkey" FOREIGN KEY (code_id) REFERENCES payment_code_definitions(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."payment_codes"
    ADD CONSTRAINT "payment_codes_payment_id_fkey" FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."payment_groups"
    ADD CONSTRAINT "payment_groups_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."payment_groups"
    ADD CONSTRAINT "payment_groups_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_bank_transaction_id_fkey" FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE SET NULL;

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_payment_group_id_fkey" FOREIGN KEY (payment_group_id) REFERENCES payment_groups(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_payshap_target_id_fkey" FOREIGN KEY (payshap_target_id) REFERENCES payshap_targets(id) ON DELETE SET NULL;

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_txn_id_fkey" FOREIGN KEY (txn_id) REFERENCES txns(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."payouts"
    ADD CONSTRAINT "payouts_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."payshap_targets"
    ADD CONSTRAINT "payshap_targets_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."reconciliation_log"
    ADD CONSTRAINT "reconciliation_log_bank_transaction_id_fkey" FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."reconciliation_log"
    ADD CONSTRAINT "reconciliation_log_payment_id_fkey" FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."refunds"
    ADD CONSTRAINT "refunds_txn_id_fkey" FOREIGN KEY (txn_id) REFERENCES txns(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."transaction_fees"
    ADD CONSTRAINT "transaction_fees_txn_id_fkey" FOREIGN KEY (txn_id) REFERENCES txns(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."txns"
    ADD CONSTRAINT "txns_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."txns"
    ADD CONSTRAINT "txns_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."unmatched_transactions"
    ADD CONSTRAINT "unmatched_transactions_bank_transaction_id_fkey" FOREIGN KEY (bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."webhooks"
    ADD CONSTRAINT "webhooks_merchant_id_fkey" FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE;

CREATE POLICY "api_key_policy" ON "public"."api_keys" USING (user_has_merchant_access(merchant_id)) WITH CHECK (user_is_admin_for_merchant(merchant_id));

ALTER TABLE "public"."api_keys" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_log_policy" ON "public"."audit_log" USING (((record_id)::text IN ( SELECT (merchants.id)::text AS id
   FROM merchants
  WHERE user_has_merchant_access(merchants.id))));

ALTER TABLE "public"."bank_account_logins" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."bank_accounts" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."bank_transactions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."customer_merchants" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_merchants_policy" ON "public"."customer_merchants" USING (user_has_merchant_access(merchant_id)) WITH CHECK (user_is_admin_for_merchant(merchant_id));

CREATE POLICY "customer_policy" ON "public"."customers" USING (((id IN ( SELECT customer_merchants.customer_id
   FROM customer_merchants
  WHERE user_has_merchant_access(customer_merchants.merchant_id))) OR (user_id = auth.uid()))) WITH CHECK (((id IN ( SELECT customer_merchants.customer_id
   FROM customer_merchants
  WHERE user_is_admin_for_merchant(customer_merchants.merchant_id))) OR (user_id = auth.uid())));

ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."merchant_bank_details" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "merchant_bank_details_policy" ON "public"."merchant_bank_details" USING (user_has_merchant_access(merchant_id)) WITH CHECK (user_is_admin_for_merchant(merchant_id));

ALTER TABLE "public"."merchant_fees" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "merchant_fees_policy" ON "public"."merchant_fees" USING (user_has_merchant_access(merchant_id)) WITH CHECK (user_is_admin_for_merchant(merchant_id));

ALTER TABLE "public"."merchant_invitations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "merchant_invitations_policy" ON "public"."merchant_invitations" USING (user_has_merchant_access(merchant_id)) WITH CHECK (user_is_admin_for_merchant(merchant_id));

CREATE POLICY "merchant_policy" ON "public"."merchants" USING (user_has_merchant_access(id)) WITH CHECK (user_is_admin_for_merchant(id));

ALTER TABLE "public"."merchant_users" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "merchant_users_policy" ON "public"."merchant_users" USING (user_has_merchant_access(merchant_id)) WITH CHECK (user_is_admin_for_merchant(merchant_id));

ALTER TABLE "public"."merchants" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."payment_code_definitions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payment_code_definitions_policy" ON "public"."payment_code_definitions" USING (true) WITH CHECK ((EXISTS ( SELECT 1
   FROM merchant_users
  WHERE ((merchant_users.user_id = auth.uid()) AND user_is_admin_for_merchant(merchant_users.merchant_id)))));

CREATE POLICY "payment_code_policy" ON "public"."payment_codes" USING ((payment_id IN ( SELECT p.id
   FROM (payments p
     JOIN payment_groups pg ON ((p.payment_group_id = pg.id)))
  WHERE (user_has_merchant_access(pg.merchant_id) OR (pg.customer_id IN ( SELECT customers.id
           FROM customers
          WHERE (customers.user_id = auth.uid()))))))) WITH CHECK ((payment_id IN ( SELECT p.id
   FROM (payments p
     JOIN payment_groups pg ON ((p.payment_group_id = pg.id)))
  WHERE (user_has_merchant_access(pg.merchant_id) OR (pg.customer_id IN ( SELECT customers.id
           FROM customers
          WHERE (customers.user_id = auth.uid())))))));

ALTER TABLE "public"."payment_codes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payment_group_policy" ON "public"."payment_groups" USING ((user_has_merchant_access(merchant_id) OR (customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.user_id = auth.uid()))))) WITH CHECK ((user_has_merchant_access(merchant_id) OR (customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.user_id = auth.uid())))));

ALTER TABLE "public"."payment_groups" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payment_policy" ON "public"."payments" USING ((payment_group_id IN ( SELECT payment_groups.id
   FROM payment_groups
  WHERE (user_has_merchant_access(payment_groups.merchant_id) OR (payment_groups.customer_id IN ( SELECT customers.id
           FROM customers
          WHERE (customers.user_id = auth.uid()))))))) WITH CHECK ((payment_group_id IN ( SELECT payment_groups.id
   FROM payment_groups
  WHERE (user_has_merchant_access(payment_groups.merchant_id) OR (payment_groups.customer_id IN ( SELECT customers.id
           FROM customers
          WHERE (customers.user_id = auth.uid())))))));

ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payout_policy" ON "public"."payouts" USING (user_has_merchant_access(merchant_id)) WITH CHECK (user_is_admin_for_merchant(merchant_id));

ALTER TABLE "public"."payouts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payshap_target_policy" ON "public"."payshap_targets" USING (user_has_merchant_access(merchant_id)) WITH CHECK (user_is_admin_for_merchant(merchant_id));

ALTER TABLE "public"."payshap_targets" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profile_policy" ON "public"."profiles" USING (((auth.uid() = id) OR (EXISTS ( SELECT 1
   FROM (merchant_users mu
     JOIN merchants m ON ((mu.merchant_id = m.id)))
  WHERE ((mu.user_id = profiles.id) AND user_is_admin_for_merchant(m.id))))));

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."reconciliation_log" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "refund_policy" ON "public"."refunds" USING ((txn_id IN ( SELECT txns.id
   FROM txns
  WHERE user_has_merchant_access(txns.merchant_id)))) WITH CHECK ((txn_id IN ( SELECT txns.id
   FROM txns
  WHERE user_is_admin_for_merchant(txns.merchant_id))));

ALTER TABLE "public"."refunds" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."roles" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "roles_policy" ON "public"."roles" USING (true) WITH CHECK (false);

ALTER TABLE "public"."transaction_fees" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "transaction_fees_policy" ON "public"."transaction_fees" USING ((txn_id IN ( SELECT txns.id
   FROM txns
  WHERE user_has_merchant_access(txns.merchant_id)))) WITH CHECK ((txn_id IN ( SELECT txns.id
   FROM txns
  WHERE user_is_admin_for_merchant(txns.merchant_id))));

CREATE POLICY "txn_policy" ON "public"."txns" USING (user_has_merchant_access(merchant_id)) WITH CHECK (user_is_admin_for_merchant(merchant_id));

ALTER TABLE "public"."txns" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."unmatched_transactions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "webhook_policy" ON "public"."webhooks" USING (user_has_merchant_access(merchant_id)) WITH CHECK (user_is_admin_for_merchant(merchant_id));

ALTER TABLE "public"."webhooks" ENABLE ROW LEVEL SECURITY;

ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."bank_transactions";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."payment_groups";

GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
GRANT USAGE ON SCHEMA "public" TO "supabase_auth_admin";

GRANT ALL ON FUNCTION "public"."gtrgm_in"(cstring) TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_in"(cstring) TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_in"(cstring) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_in"(cstring) TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_out"(gtrgm) TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_out"(gtrgm) TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_out"(gtrgm) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_out"(gtrgm) TO "service_role";

GRANT ALL ON FUNCTION "public"."accept_merchant_invitation"(p_token text) TO "anon";
GRANT ALL ON FUNCTION "public"."accept_merchant_invitation"(p_token text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_merchant_invitation"(p_token text) TO "service_role";

GRANT ALL ON FUNCTION "public"."create_customer_session"(p_customer_id uuid, p_duration interval) TO "anon";
GRANT ALL ON FUNCTION "public"."create_customer_session"(p_customer_id uuid, p_duration interval) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_customer_session"(p_customer_id uuid, p_duration interval) TO "service_role";

GRANT ALL ON FUNCTION "public"."create_simple_payment"(p_merchant_id uuid, p_customer_name text, p_customer_email text, p_customer_phone text, p_total_amount numeric, p_currency text, p_payment_method text) TO "anon";
GRANT ALL ON FUNCTION "public"."create_simple_payment"(p_merchant_id uuid, p_customer_name text, p_customer_email text, p_customer_phone text, p_total_amount numeric, p_currency text, p_payment_method text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_simple_payment"(p_merchant_id uuid, p_customer_name text, p_customer_email text, p_customer_phone text, p_total_amount numeric, p_currency text, p_payment_method text) TO "service_role";

REVOKE ALL ON FUNCTION "public"."custom_access_token_hook"(event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"(event jsonb) TO "service_role";
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"(event jsonb) TO "supabase_auth_admin";

GRANT ALL ON FUNCTION "public"."find_unique_payment_code"() TO "anon";
GRANT ALL ON FUNCTION "public"."find_unique_payment_code"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."find_unique_payment_code"() TO "service_role";

GRANT ALL ON FUNCTION "public"."generate_invitation_token"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_invitation_token"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_invitation_token"() TO "service_role";

GRANT ALL ON FUNCTION "public"."generate_payment_codes"(num_codes integer) TO "anon";
GRANT ALL ON FUNCTION "public"."generate_payment_codes"(num_codes integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_payment_codes"(num_codes integer) TO "service_role";

GRANT ALL ON FUNCTION "public"."generate_secure_token"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_secure_token"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_secure_token"() TO "service_role";

GRANT ALL ON FUNCTION "public"."get_current_customer_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_current_customer_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_current_customer_id"() TO "service_role";

GRANT ALL ON FUNCTION "public"."get_merchant"(p_merchant_handle text) TO "anon";
GRANT ALL ON FUNCTION "public"."get_merchant"(p_merchant_handle text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_merchant"(p_merchant_handle text) TO "service_role";

GRANT ALL ON FUNCTION "public"."get_merchant_daily_revenue_and_payout"(p_merchant_id uuid, p_start_date date, p_end_date date) TO "anon";
GRANT ALL ON FUNCTION "public"."get_merchant_daily_revenue_and_payout"(p_merchant_id uuid, p_start_date date, p_end_date date) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_merchant_daily_revenue_and_payout"(p_merchant_id uuid, p_start_date date, p_end_date date) TO "service_role";

GRANT ALL ON FUNCTION "public"."get_merchant_total_fees"(p_merchant_id uuid, p_start_date date, p_end_date date) TO "anon";
GRANT ALL ON FUNCTION "public"."get_merchant_total_fees"(p_merchant_id uuid, p_start_date date, p_end_date date) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_merchant_total_fees"(p_merchant_id uuid, p_start_date date, p_end_date date) TO "service_role";

GRANT ALL ON FUNCTION "public"."get_or_invite_user"(p_merchant_id uuid, p_email text, p_role_name text) TO "anon";
GRANT ALL ON FUNCTION "public"."get_or_invite_user"(p_merchant_id uuid, p_email text, p_role_name text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_or_invite_user"(p_merchant_id uuid, p_email text, p_role_name text) TO "service_role";

GRANT ALL ON FUNCTION "public"."get_payment_group_details"(payment_group_id uuid) TO "anon";
GRANT ALL ON FUNCTION "public"."get_payment_group_details"(payment_group_id uuid) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_payment_group_details"(payment_group_id uuid) TO "service_role";

GRANT ALL ON FUNCTION "public"."get_recent_transactions"(p_merchant_id uuid, p_limit_num integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_recent_transactions"(p_merchant_id uuid, p_limit_num integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_recent_transactions"(p_merchant_id uuid, p_limit_num integer) TO "service_role";

GRANT ALL ON FUNCTION "public"."get_top_customers"(p_merchant_id uuid, p_start_date date, p_end_date date, p_limit_num integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_top_customers"(p_merchant_id uuid, p_start_date date, p_end_date date, p_limit_num integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_top_customers"(p_merchant_id uuid, p_start_date date, p_end_date date, p_limit_num integer) TO "service_role";

GRANT ALL ON FUNCTION "public"."get_transaction_stats"(p_merchant_id uuid, p_start_date date, p_end_date date) TO "anon";
GRANT ALL ON FUNCTION "public"."get_transaction_stats"(p_merchant_id uuid, p_start_date date, p_end_date date) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_transaction_stats"(p_merchant_id uuid, p_start_date date, p_end_date date) TO "service_role";

GRANT ALL ON FUNCTION "public"."get_user_merchant_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_merchant_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_merchant_id"() TO "service_role";
GRANT ALL ON FUNCTION "public"."get_user_merchant_id"() TO "supabase_auth_admin";

GRANT ALL ON FUNCTION "public"."get_user_merchants_and_roles"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_merchants_and_roles"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_merchants_and_roles"() TO "service_role";

GRANT ALL ON FUNCTION "public"."get_user_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_role"() TO "service_role";
GRANT ALL ON FUNCTION "public"."get_user_role"() TO "supabase_auth_admin";

GRANT ALL ON FUNCTION "public"."get_user_role_for_merchant"(merchant_id uuid) TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_role_for_merchant"(merchant_id uuid) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_role_for_merchant"(merchant_id uuid) TO "service_role";
GRANT ALL ON FUNCTION "public"."get_user_role_for_merchant"(merchant_id uuid) TO "supabase_auth_admin";

GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"(text, internal, smallint, internal, internal, internal, internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"(text, internal, smallint, internal, internal, internal, internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"(text, internal, smallint, internal, internal, internal, internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"(text, internal, smallint, internal, internal, internal, internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"(text, internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"(text, internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"(text, internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"(text, internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"(internal, smallint, text, integer, internal, internal, internal, internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"(internal, smallint, text, integer, internal, internal, internal, internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"(internal, smallint, text, integer, internal, internal, internal, internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"(internal, smallint, text, integer, internal, internal, internal, internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"(internal, smallint, text, integer, internal, internal, internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"(internal, smallint, text, integer, internal, internal, internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"(internal, smallint, text, integer, internal, internal, internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"(internal, smallint, text, integer, internal, internal, internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_compress"(internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"(internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"(internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"(internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_consistent"(internal, text, smallint, oid, internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"(internal, text, smallint, oid, internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"(internal, text, smallint, oid, internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"(internal, text, smallint, oid, internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_decompress"(internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"(internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"(internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"(internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_distance"(internal, text, smallint, oid, internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"(internal, text, smallint, oid, internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"(internal, text, smallint, oid, internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"(internal, text, smallint, oid, internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_options"(internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_options"(internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_options"(internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_options"(internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_penalty"(internal, internal, internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"(internal, internal, internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"(internal, internal, internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"(internal, internal, internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"(internal, internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"(internal, internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"(internal, internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"(internal, internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_same"(gtrgm, gtrgm, internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_same"(gtrgm, gtrgm, internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_same"(gtrgm, gtrgm, internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_same"(gtrgm, gtrgm, internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."gtrgm_union"(internal, internal) TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_union"(internal, internal) TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_union"(internal, internal) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_union"(internal, internal) TO "service_role";

GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";

GRANT ALL ON FUNCTION "public"."mark_code_inactive"(p_code text) TO "anon";
GRANT ALL ON FUNCTION "public"."mark_code_inactive"(p_code text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."mark_code_inactive"(p_code text) TO "service_role";

GRANT ALL ON FUNCTION "public"."process_new_bank_transaction"() TO "anon";
GRANT ALL ON FUNCTION "public"."process_new_bank_transaction"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."process_new_bank_transaction"() TO "service_role";

GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "postgres";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "anon";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "service_role";

GRANT ALL ON FUNCTION "public"."show_limit"() TO "postgres";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "service_role";

GRANT ALL ON FUNCTION "public"."show_trgm"(text) TO "postgres";
GRANT ALL ON FUNCTION "public"."show_trgm"(text) TO "anon";
GRANT ALL ON FUNCTION "public"."show_trgm"(text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_trgm"(text) TO "service_role";

GRANT ALL ON FUNCTION "public"."similarity"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."similarity"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity"(text, text) TO "service_role";

GRANT ALL ON FUNCTION "public"."similarity_dist"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_dist"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_dist"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_dist"(text, text) TO "service_role";

GRANT ALL ON FUNCTION "public"."similarity_op"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_op"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_op"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_op"(text, text) TO "service_role";

GRANT ALL ON FUNCTION "public"."strict_word_similarity"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"(text, text) TO "service_role";

GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"(text, text) TO "service_role";

GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"(text, text) TO "service_role";

GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"(text, text) TO "service_role";

GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"(text, text) TO "service_role";

GRANT ALL ON FUNCTION "public"."use_payment_code"(p_code text, p_payment_id uuid) TO "anon";
GRANT ALL ON FUNCTION "public"."use_payment_code"(p_code text, p_payment_id uuid) TO "authenticated";
GRANT ALL ON FUNCTION "public"."use_payment_code"(p_code text, p_payment_id uuid) TO "service_role";

GRANT ALL ON FUNCTION "public"."user_has_merchant_access"(merchant_id uuid) TO "anon";
GRANT ALL ON FUNCTION "public"."user_has_merchant_access"(merchant_id uuid) TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_has_merchant_access"(merchant_id uuid) TO "service_role";
GRANT ALL ON FUNCTION "public"."user_has_merchant_access"(merchant_id uuid) TO "supabase_auth_admin";

GRANT ALL ON FUNCTION "public"."user_is_admin_for_merchant"(merchant_id uuid) TO "anon";
GRANT ALL ON FUNCTION "public"."user_is_admin_for_merchant"(merchant_id uuid) TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_is_admin_for_merchant"(merchant_id uuid) TO "service_role";
GRANT ALL ON FUNCTION "public"."user_is_admin_for_merchant"(merchant_id uuid) TO "supabase_auth_admin";

GRANT ALL ON FUNCTION "public"."validate_customer_session"(p_token text) TO "anon";
GRANT ALL ON FUNCTION "public"."validate_customer_session"(p_token text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_customer_session"(p_token text) TO "service_role";

GRANT ALL ON FUNCTION "public"."word_similarity"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity"(text, text) TO "service_role";

GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"(text, text) TO "service_role";

GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"(text, text) TO "service_role";

GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"(text, text) TO "service_role";

GRANT ALL ON FUNCTION "public"."word_similarity_op"(text, text) TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_op"(text, text) TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_op"(text, text) TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_op"(text, text) TO "service_role";

GRANT ALL ON TABLE "public"."api_keys" TO "anon";
GRANT ALL ON TABLE "public"."api_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."api_keys" TO "service_role";
GRANT SELECT ON TABLE "public"."api_keys" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."audit_log" TO "anon";
GRANT ALL ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";
GRANT SELECT ON TABLE "public"."audit_log" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."bank_account_logins" TO "anon";
GRANT ALL ON TABLE "public"."bank_account_logins" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_account_logins" TO "service_role";

GRANT ALL ON TABLE "public"."bank_accounts" TO "anon";
GRANT ALL ON TABLE "public"."bank_accounts" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_accounts" TO "service_role";
GRANT SELECT ON TABLE "public"."bank_accounts" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."bank_transactions" TO "anon";
GRANT ALL ON TABLE "public"."bank_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."bank_transactions" TO "service_role";
GRANT SELECT ON TABLE "public"."bank_transactions" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."customer_merchants" TO "anon";
GRANT ALL ON TABLE "public"."customer_merchants" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_merchants" TO "service_role";
GRANT SELECT ON TABLE "public"."customer_merchants" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."customers" TO "anon";
GRANT ALL ON TABLE "public"."customers" TO "authenticated";
GRANT ALL ON TABLE "public"."customers" TO "service_role";
GRANT SELECT ON TABLE "public"."customers" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."merchant_bank_details" TO "anon";
GRANT REFERENCES,TRIGGER,TRUNCATE ON TABLE "public"."merchant_bank_details" TO "authenticated";
GRANT ALL ON TABLE "public"."merchant_bank_details" TO "service_role";
GRANT SELECT ON TABLE "public"."merchant_bank_details" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."merchant_fees" TO "anon";
GRANT ALL ON TABLE "public"."merchant_fees" TO "authenticated";
GRANT ALL ON TABLE "public"."merchant_fees" TO "service_role";
GRANT SELECT ON TABLE "public"."merchant_fees" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."merchant_invitations" TO "anon";
GRANT ALL ON TABLE "public"."merchant_invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."merchant_invitations" TO "service_role";
GRANT SELECT ON TABLE "public"."merchant_invitations" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."merchant_users" TO "anon";
GRANT ALL ON TABLE "public"."merchant_users" TO "authenticated";
GRANT ALL ON TABLE "public"."merchant_users" TO "service_role";
GRANT SELECT ON TABLE "public"."merchant_users" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."merchants" TO "anon";
GRANT ALL ON TABLE "public"."merchants" TO "authenticated";
GRANT ALL ON TABLE "public"."merchants" TO "service_role";
GRANT SELECT ON TABLE "public"."merchants" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."payment_code_definitions" TO "anon";
GRANT ALL ON TABLE "public"."payment_code_definitions" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_code_definitions" TO "service_role";
GRANT SELECT ON TABLE "public"."payment_code_definitions" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."payment_codes" TO "anon";
GRANT ALL ON TABLE "public"."payment_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_codes" TO "service_role";
GRANT SELECT ON TABLE "public"."payment_codes" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."payment_groups" TO "anon";
GRANT ALL ON TABLE "public"."payment_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."payment_groups" TO "service_role";
GRANT SELECT ON TABLE "public"."payment_groups" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";
GRANT SELECT ON TABLE "public"."payments" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."payouts" TO "anon";
GRANT ALL ON TABLE "public"."payouts" TO "authenticated";
GRANT ALL ON TABLE "public"."payouts" TO "service_role";
GRANT SELECT ON TABLE "public"."payouts" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."payshap_targets" TO "anon";
GRANT ALL ON TABLE "public"."payshap_targets" TO "authenticated";
GRANT ALL ON TABLE "public"."payshap_targets" TO "service_role";
GRANT SELECT ON TABLE "public"."payshap_targets" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";
GRANT SELECT ON TABLE "public"."profiles" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."reconciliation_log" TO "anon";
GRANT ALL ON TABLE "public"."reconciliation_log" TO "authenticated";
GRANT ALL ON TABLE "public"."reconciliation_log" TO "service_role";
GRANT SELECT ON TABLE "public"."reconciliation_log" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."refunds" TO "anon";
GRANT ALL ON TABLE "public"."refunds" TO "authenticated";
GRANT ALL ON TABLE "public"."refunds" TO "service_role";
GRANT SELECT ON TABLE "public"."refunds" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."roles" TO "anon";
GRANT ALL ON TABLE "public"."roles" TO "authenticated";
GRANT ALL ON TABLE "public"."roles" TO "service_role";
GRANT SELECT ON TABLE "public"."roles" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."transaction_fees" TO "anon";
GRANT ALL ON TABLE "public"."transaction_fees" TO "authenticated";
GRANT ALL ON TABLE "public"."transaction_fees" TO "service_role";
GRANT SELECT ON TABLE "public"."transaction_fees" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."txns" TO "anon";
GRANT ALL ON TABLE "public"."txns" TO "authenticated";
GRANT ALL ON TABLE "public"."txns" TO "service_role";
GRANT SELECT ON TABLE "public"."txns" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."unmatched_transactions" TO "anon";
GRANT ALL ON TABLE "public"."unmatched_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."unmatched_transactions" TO "service_role";
GRANT SELECT ON TABLE "public"."unmatched_transactions" TO "supabase_auth_admin";

GRANT ALL ON TABLE "public"."webhooks" TO "anon";
GRANT ALL ON TABLE "public"."webhooks" TO "authenticated";
GRANT ALL ON TABLE "public"."webhooks" TO "service_role";
GRANT SELECT ON TABLE "public"."webhooks" TO "supabase_auth_admin";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "service_role";

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "service_role";

RESET ALL;
