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

-- Function to create a customer session
CREATE OR REPLACE FUNCTION create_customer_session(p_customer_id UUID, p_duration INTERVAL DEFAULT INTERVAL '24 hours')
RETURNS TABLE (token TEXT) AS $$
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