-- File: 03-custom-functions.sql
-- Description: Custom functions for the payment system

-- Function to generate a base32 encoding alphabet (excluding I, O, 1, 0 for clarity)
CREATE OR REPLACE FUNCTION get_base32_alphabet() RETURNS TEXT AS $$
BEGIN
    RETURN 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to encode a bigint to base32
CREATE OR REPLACE FUNCTION encode_base32(value BIGINT) RETURNS TEXT AS $$
DECLARE
    alphabet TEXT := get_base32_alphabet();
    base INT := length(alphabet);
    result TEXT := '';
    mod INT;
BEGIN
    WHILE value > 0 LOOP
        mod := value % base;
        result := substr(alphabet, mod + 1, 1) || result;
        value := value / base;
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to decode a base32 string to bigint
CREATE OR REPLACE FUNCTION decode_base32(encoded TEXT) RETURNS BIGINT AS $$
DECLARE
    alphabet TEXT := get_base32_alphabet();
    base INT := length(alphabet);
    result BIGINT := 0;
    i INT;
    c CHAR;
    v INT;
BEGIN
    FOR i IN 1..length(encoded) LOOP
        c := upper(substr(encoded, i, 1));
        v := position(c IN alphabet) - 1;
        IF v < 0 THEN
            RAISE EXCEPTION 'Invalid character in base32 string: %', c;
        END IF;
        result := result * base + v;
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to generate a transaction code
CREATE OR REPLACE FUNCTION generate_transaction_code(p_merchant_id UUID) RETURNS TEXT AS $$
DECLARE
    timestamp_part BIGINT;
    merchant_part BIGINT;
    random_part BIGINT;
    check_digit CHAR;
    code TEXT;
BEGIN
    -- Get current timestamp (milliseconds since epoch)
    timestamp_part := (extract(epoch from current_timestamp) * 1000)::BIGINT;
    
    -- Get last 4 bytes of merchant_id
    merchant_part := ('x' || right(p_merchant_id::TEXT, 8))::BIT(32)::BIGINT;
    
    -- Generate 2 bytes of random data
    random_part := floor(random() * 65536)::BIGINT;
    
    -- Combine parts
    code := encode_base32(timestamp_part) || '-' ||
            encode_base32(merchant_part) || '-' ||
            encode_base32(random_part);
    
    -- Calculate check digit (simple sum of ascii values modulo 32)
    SELECT chr(65 + (sum(ascii(c)) % 32)) INTO check_digit
    FROM regexp_split_to_table(replace(code, '-', ''), '') AS c;
    
    RETURN code || check_digit;
END;
$$ LANGUAGE plpgsql;

-- Function to validate a transaction code
CREATE OR REPLACE FUNCTION validate_transaction_code(p_code TEXT) RETURNS BOOLEAN AS $$
DECLARE
    code_parts TEXT[];
    check_digit CHAR;
    calculated_check_digit CHAR;
BEGIN
    -- Split the code into parts
    code_parts := string_to_array(p_code, '-');
    
    -- Check if the code has the correct format
    IF array_length(code_parts, 1) != 3 OR length(code_parts[3]) != 5 THEN
        RETURN FALSE;
    END IF;
    
    -- Extract check digit
    check_digit := right(code_parts[3], 1);
    code_parts[3] := left(code_parts[3], 4);
    
    -- Recalculate check digit
    SELECT chr(65 + (sum(ascii(c)) % 32)) INTO calculated_check_digit
    FROM regexp_split_to_table(array_to_string(code_parts, ''), '') AS c;
    
    -- Compare check digits
    RETURN check_digit = calculated_check_digit;
END;
$$ LANGUAGE plpgsql;

-- Function to extract timestamp from a transaction code
CREATE OR REPLACE FUNCTION extract_timestamp_from_code(p_code TEXT) RETURNS TIMESTAMP AS $$
DECLARE
    timestamp_part TEXT;
    timestamp_value BIGINT;
BEGIN
    timestamp_part := split_part(p_code, '-', 1);
    timestamp_value := decode_base32(timestamp_part);
    RETURN to_timestamp(timestamp_value / 1000.0);
END;
$$ LANGUAGE plpgsql;

-- Function to find a unique, unused transaction code
CREATE OR REPLACE FUNCTION find_unique_transaction_code(p_merchant_id UUID) RETURNS TEXT AS $$
DECLARE
    code TEXT;
    max_attempts INTEGER := 10;
    attempt INTEGER := 0;
BEGIN
    LOOP
        code := generate_transaction_code(p_merchant_id);
        
        -- Check if the code is already in use
        IF NOT EXISTS (
            SELECT 1 FROM transaction_codes 
            WHERE code = code 
            AND status = 'active'
        ) THEN
            RETURN code;
        END IF;
        
        attempt := attempt + 1;
        IF attempt >= max_attempts THEN
            RAISE EXCEPTION 'Unable to generate a unique transaction code after % attempts', max_attempts;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Function to find a transaction code with fuzzy matching
CREATE OR REPLACE FUNCTION find_transaction_code(input_code TEXT) RETURNS TEXT AS $$
DECLARE
    matched_code TEXT;
    input_parts TEXT[];
    db_parts TEXT[];
BEGIN
    -- Normalize input code
    input_code := upper(regexp_replace(input_code, '[^A-Z0-9]', '', 'g'));
    input_parts := regexp_split_to_array(input_code, '(?<=^.{5})(?=.{5,})');

    -- Try exact match first
    SELECT code INTO matched_code
    FROM transaction_codes
    WHERE replace(code, '-', '') = input_code AND status = 'active';
    
    -- If not found, try partial match
    IF matched_code IS NULL THEN
        SELECT code INTO matched_code
        FROM transaction_codes
        WHERE status = 'active'
        AND (
            -- Match first part (timestamp) and at least half of the second part (merchant_id)
            left(replace(code, '-', ''), 5) = COALESCE(input_parts[1], '')
            AND left(substr(replace(code, '-', ''), 6), 4) = left(COALESCE(input_parts[2], ''), 4)
        )
        ORDER BY 
            -- Prioritize codes that match more characters
            length(regexp_replace(replace(code, '-', ''), '[^' || input_code || ']', '', 'g')) DESC,
            -- For equal matches, prioritize newer codes
            extract_timestamp_from_code(code) DESC
        LIMIT 1;
    END IF;
    
    RETURN matched_code;
END;
$$ LANGUAGE plpgsql;

-- Function to create a payment group with a simple payment
CREATE OR REPLACE FUNCTION create_payment_group_with_simple_payment(
    p_merchant_id UUID,
    p_customer_id UUID,
    p_user_id UUID,
    p_total_amount DECIMAL(10, 2),
    p_currency TEXT DEFAULT 'ZAR'
) RETURNS TABLE (payment_group_id UUID, session_token TEXT) AS $$
DECLARE
    v_txn_id UUID;
    v_payment_group_id UUID;
    v_payment_id UUID;
    v_transaction_code TEXT;
    v_session_token TEXT;
BEGIN
    -- Start transaction
    BEGIN
        -- Create transaction
        INSERT INTO txns (merchant_id, customer_id, txn_number, total_amount, currency, status, type)
        VALUES (p_merchant_id, p_customer_id, 'TXN-' || gen_random_uuid(), p_total_amount, p_currency, 'pending', 'simple_payment')
        RETURNING id INTO v_txn_id;

        -- Create payment group
        INSERT INTO payment_groups (txn_id, total_amount, status)
        VALUES (v_txn_id, p_total_amount, 'pending')
        RETURNING id INTO v_payment_group_id;

        -- Create payment
        INSERT INTO payments (payment_group_id, amount_charged, status)
        VALUES (v_payment_group_id, p_total_amount, 'pending')
        RETURNING id INTO v_payment_id;

        -- Generate and insert transaction code
        v_transaction_code := find_unique_transaction_code(p_merchant_id);
        INSERT INTO transaction_codes (payment_group_id, code, status, expires_at)
        VALUES (v_payment_group_id, v_transaction_code, 'active', CURRENT_TIMESTAMP + INTERVAL '24 hours');

        -- If user_id is provided, create a customer session
        IF p_user_id IS NOT NULL THEN
            SELECT token INTO v_session_token
            FROM create_customer_session(p_user_id);
        END IF;

        -- Commit transaction
        RETURN QUERY SELECT v_payment_group_id, v_session_token;
    EXCEPTION WHEN OTHERS THEN
        -- Rollback transaction in case of any error
        RAISE;
    END;
END;
$$ LANGUAGE plpgsql;
-- Function to mark a transaction code as used
CREATE OR REPLACE FUNCTION mark_transaction_code_used(p_code TEXT) RETURNS VOID AS $$
BEGIN
    UPDATE transaction_codes
    SET status = 'used'
    WHERE code = upper(p_code);
END;
$$ LANGUAGE plpgsql;

-- Function to reactivate expired transaction codes
CREATE OR REPLACE FUNCTION reactivate_expired_transaction_codes() RETURNS INTEGER AS $$
DECLARE
    reactivated_count INTEGER;
BEGIN
    UPDATE transaction_codes
    SET status = 'active', expires_at = CURRENT_TIMESTAMP + INTERVAL '24 hours'
    WHERE status = 'expired' AND expires_at < CURRENT_TIMESTAMP;

    GET DIAGNOSTICS reactivated_count = ROW_COUNT;
    RETURN reactivated_count;
END;
$$ LANGUAGE plpgsql;

-- Function to generate a secure token for customer sessions
CREATE OR REPLACE FUNCTION generate_secure_token() RETURNS TEXT AS $$
DECLARE
    token TEXT;
BEGIN
    -- Generate a random UUID and hash it
    token := encode(digest(gen_random_uuid()::text, 'sha256'), 'hex');
    RETURN token;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to create a new customer session
CREATE OR REPLACE FUNCTION create_customer_session(p_customer_id UUID, p_duration INTERVAL DEFAULT INTERVAL '24 hours')
RETURNS TEXT AS $$
DECLARE
    v_token TEXT;
BEGIN
    -- Generate a secure token
    v_token := generate_secure_token();
    
    -- Insert the new session
    INSERT INTO customer_sessions (customer_id, token, expires_at)
    VALUES (p_customer_id, v_token, CURRENT_TIMESTAMP + p_duration);
    
    RETURN v_token;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to validate a customer session
CREATE OR REPLACE FUNCTION validate_customer_session(p_token TEXT)
RETURNS UUID AS $$
DECLARE
    v_customer_id UUID;
BEGIN
    -- Find a valid, non-expired session
    SELECT customer_id INTO v_customer_id
    FROM customer_sessions
    WHERE token = p_token AND expires_at > CURRENT_TIMESTAMP;
    
    -- If found, update the expiration time
    IF v_customer_id IS NOT NULL THEN
        UPDATE customer_sessions
        SET expires_at = CURRENT_TIMESTAMP + INTERVAL '24 hours'
        WHERE token = p_token;
    END IF;
    
    RETURN v_customer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to set the current customer token
CREATE OR REPLACE FUNCTION set_current_customer_token(p_token TEXT)
RETURNS VOID AS $$
BEGIN
    PERFORM set_config('app.current_customer_token', p_token, FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- Function to check if the current user is a service_role
CREATE OR REPLACE FUNCTION is_service_role()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN auth.role() = 'service_role';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check permission
CREATE OR REPLACE FUNCTION check_permission(
    p_user_id UUID,
    p_namespace TEXT,
    p_object_id TEXT,
    p_permission TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
    v_result BOOLEAN;
    v_object_id UUID;
    v_namespace_id UUID;
BEGIN
    -- Allow service_role to bypass permission check
    IF is_service_role() THEN
        RETURN TRUE;
    END IF;

    -- Get namespace_id and object_id
    SELECT id INTO v_namespace_id FROM namespaces WHERE name = p_namespace;
    SELECT id INTO v_object_id FROM objects WHERE namespace_id = v_namespace_id AND object_id = p_object_id;

    -- Check cache
    SELECT result INTO v_result
    FROM permission_cache
    WHERE user_id = p_user_id AND object_id = v_object_id AND permission = p_permission
    AND created_at > (CURRENT_TIMESTAMP - INTERVAL '1 hour');

    IF v_result IS NOT NULL THEN
        RETURN v_result;
    END IF;

    -- If not in cache, check permission
    SELECT EXISTS (
        SELECT 1
        FROM tuples t
        JOIN relations r ON t.relation_id = r.id
        JOIN permissions p ON r.id = p.relation_id AND t.namespace_id = p.namespace_id
        WHERE t.namespace_id = v_namespace_id
        AND t.object_id = v_object_id
        AND t.user_id = p_user_id
        AND p.permission = p_permission
    ) INTO v_result;

    -- Update cache
    INSERT INTO permission_cache (user_id, object_id, permission, result)
    VALUES (p_user_id, v_object_id, p_permission, v_result)
    ON CONFLICT (user_id, object_id, permission)
    DO UPDATE SET result = EXCLUDED.result, created_at = CURRENT_TIMESTAMP;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to grant permission
CREATE OR REPLACE FUNCTION grant_permission(
    p_granter_id UUID,
    p_namespace TEXT,
    p_object_id TEXT,
    p_relation TEXT,
    p_user_id UUID
)
RETURNS VOID AS $$
DECLARE
    v_namespace_id UUID;
    v_object_id UUID;
    v_relation_id UUID;
BEGIN
    -- Allow service_role to bypass permission check
    IF is_service_role() THEN
        -- Directly grant permission without checks
        INSERT INTO tuples (namespace_id, object_id, relation_id, user_id)
        VALUES (
            (SELECT id FROM namespaces WHERE name = p_namespace),
            (SELECT id FROM objects WHERE namespace_id = (SELECT id FROM namespaces WHERE name = p_namespace) AND object_id = p_object_id),
            (SELECT id FROM relations WHERE namespace_id = (SELECT id FROM namespaces WHERE name = p_namespace) AND name = p_relation),
            p_user_id
        )
        ON CONFLICT (namespace_id, object_id, relation_id, user_id) DO NOTHING;

        -- Invalidate cache
        DELETE FROM permission_cache
        WHERE object_id = (SELECT id FROM objects WHERE namespace_id = (SELECT id FROM namespaces WHERE name = p_namespace) AND object_id = p_object_id)
        AND user_id = p_user_id;

        RETURN;
    END IF;

    -- Get namespace_id
    SELECT id INTO v_namespace_id FROM namespaces WHERE name = p_namespace;
    IF v_namespace_id IS NULL THEN
        RAISE EXCEPTION 'Namespace not found';
    END IF;

    -- Get or create object_id
    SELECT id INTO v_object_id FROM objects WHERE namespace_id = v_namespace_id AND object_id = p_object_id;
    IF v_object_id IS NULL THEN
        INSERT INTO objects (namespace_id, object_id) VALUES (v_namespace_id, p_object_id) RETURNING id INTO v_object_id;
    END IF;

    -- Get relation_id
    SELECT id INTO v_relation_id FROM relations WHERE namespace_id = v_namespace_id AND name = p_relation;
    IF v_relation_id IS NULL THEN
        RAISE EXCEPTION 'Relation not found';
    END IF;

    -- Check if granter has permission to grant
    IF NOT check_permission(p_granter_id, p_namespace, p_object_id, 'grant_' || p_relation) THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    -- Grant permission
    INSERT INTO tuples (namespace_id, object_id, relation_id, user_id)
    VALUES (v_namespace_id, v_object_id, v_relation_id, p_user_id)
    ON CONFLICT (namespace_id, object_id, relation_id, user_id) DO NOTHING;

    -- Invalidate cache
    DELETE FROM permission_cache
    WHERE object_id = v_object_id AND user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to initialize merchant permissions
CREATE OR REPLACE FUNCTION initialize_merchant_permissions(p_merchant_id UUID, p_owner_id UUID)
RETURNS VOID AS $$
BEGIN
    -- Ensure the 'merchant' namespace exists
    INSERT INTO namespaces (name) VALUES ('merchant') ON CONFLICT (name) DO NOTHING;
    
    -- Ensure the 'owner' relation exists for the 'merchant' namespace
    INSERT INTO relations (namespace_id, name)
    SELECT id, 'owner'
    FROM namespaces
    WHERE name = 'merchant'
    ON CONFLICT (namespace_id, name) DO NOTHING;
    
    -- Create object for the merchant
    INSERT INTO objects (namespace_id, object_id)
    SELECT n.id, p_merchant_id::text
    FROM namespaces n
    WHERE n.name = 'merchant'
    ON CONFLICT (namespace_id, object_id) DO NOTHING;

    -- Directly grant owner permission without checking
    INSERT INTO tuples (namespace_id, object_id, relation_id, user_id)
    VALUES (
        (SELECT id FROM namespaces WHERE name = 'merchant'),
        (SELECT id FROM objects WHERE namespace_id = (SELECT id FROM namespaces WHERE name = 'merchant') AND object_id = p_merchant_id::text),
        (SELECT id FROM relations WHERE namespace_id = (SELECT id FROM namespaces WHERE name = 'merchant') AND name = 'owner'),
        p_owner_id
    )
    ON CONFLICT (namespace_id, object_id, relation_id, user_id) DO NOTHING;

    -- Invalidate cache
    DELETE FROM permission_cache
    WHERE object_id = (SELECT id FROM objects WHERE namespace_id = (SELECT id FROM namespaces WHERE name = 'merchant') AND object_id = p_merchant_id::text)
    AND user_id = p_owner_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant necessary privileges to the service_role
GRANT EXECUTE ON FUNCTION is_service_role() TO service_role;
GRANT EXECUTE ON FUNCTION check_permission(UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION grant_permission(UUID, TEXT, TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION initialize_merchant_permissions(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION generate_transaction_code(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION validate_transaction_code(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION extract_timestamp_from_code(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION find_unique_transaction_code(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION find_transaction_code(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION create_payment_group_with_simple_payment(UUID, UUID, UUID, DECIMAL, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION mark_transaction_code_used(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION reactivate_expired_transaction_codes() TO service_role;
GRANT EXECUTE ON FUNCTION generate_secure_token() TO service_role;
GRANT EXECUTE ON FUNCTION create_customer_session(UUID, INTERVAL) TO service_role;
GRANT EXECUTE ON FUNCTION validate_customer_session(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION set_current_customer_token(TEXT) TO service_role;