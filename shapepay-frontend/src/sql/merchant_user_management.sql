-- Function to generate invitation token
CREATE OR REPLACE FUNCTION generate_invitation_token() RETURNS TEXT AS $$
BEGIN
    RETURN encode(gen_random_bytes(32), 'hex');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get or invite a user
CREATE OR REPLACE FUNCTION get_or_invite_user(
    p_merchant_id UUID,
    p_email TEXT,
    p_role_name TEXT
) RETURNS TABLE (return_user_id UUID, is_new BOOLEAN, invitation_token TEXT) AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to accept a merchant invitation
CREATE OR REPLACE FUNCTION accept_merchant_invitation(p_token TEXT) RETURNS BOOLEAN AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;