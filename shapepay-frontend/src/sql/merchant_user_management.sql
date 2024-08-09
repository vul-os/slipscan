-- Function to generate a secure invitation token
CREATE OR REPLACE FUNCTION generate_invitation_token() RETURNS TEXT AS $$
BEGIN
    RETURN encode(gen_random_bytes(32), 'hex');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get or invite a user by email
CREATE OR REPLACE FUNCTION get_or_invite_user(
    p_merchant_id UUID,
    p_email TEXT,
    p_role_name TEXT
) RETURNS TABLE (user_id UUID, is_new BOOLEAN, invitation_token TEXT) AS $$
DECLARE
    v_user_id UUID;
    v_token TEXT;
BEGIN
    -- Check if the user already exists
    SELECT id INTO v_user_id FROM auth.users WHERE email = p_email;
    
    IF v_user_id IS NOT NULL THEN
        -- User exists
        RETURN QUERY SELECT v_user_id, FALSE, NULL::TEXT;
    ELSE
        -- User doesn't exist, create an invitation
        v_token := generate_invitation_token();
        
        INSERT INTO merchant_invitations (merchant_id, email, role_name, token, expires_at)
        VALUES (p_merchant_id, p_email, p_role_name, v_token, CURRENT_TIMESTAMP + INTERVAL '7 days')
        ON CONFLICT (merchant_id, email) DO UPDATE
        SET role_name = EXCLUDED.role_name,
            token = EXCLUDED.token,
            expires_at = EXCLUDED.expires_at;
        
        -- TODO: Send invitation email with the token
        
        RETURN QUERY SELECT NULL::UUID, TRUE, v_token;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to accept an invitation
CREATE OR REPLACE FUNCTION accept_merchant_invitation(p_token TEXT) RETURNS BOOLEAN AS $$
DECLARE
    v_invitation merchant_invitations%ROWTYPE;
    v_user_id UUID;
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
    
    -- Add the user to the merchant with the specified role
    PERFORM manage_merchant_user(v_invitation.merchant_id, v_user_id, v_invitation.role_name, 'add');
    
    -- Delete the invitation
    DELETE FROM merchant_invitations WHERE id = v_invitation.id;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Updated function to manage merchant users
CREATE OR REPLACE FUNCTION manage_merchant_user(
    p_merchant_id UUID,
    p_email TEXT,
    p_role_name TEXT,
    p_action TEXT -- 'add', 'update', or 'remove'
) RETURNS TABLE (success BOOLEAN, message TEXT, invitation_token TEXT) AS $$
DECLARE
    v_current_user_id UUID;
    v_is_admin BOOLEAN;
    v_role_id UUID;
    v_user_info RECORD;
BEGIN
    -- Get the current user's ID
    v_current_user_id := auth.uid();
    
    -- Check if the current user is an admin of the merchant
    SELECT EXISTS (
        SELECT 1
        FROM merchant_users mu
        JOIN user_roles ur ON mu.merchant_id = ur.merchant_id AND mu.user_id = ur.user_id
        JOIN roles r ON ur.role_id = r.id
        WHERE mu.merchant_id = p_merchant_id
        AND mu.user_id = v_current_user_id
        AND r.name = 'admin'
    ) INTO v_is_admin;
    
    -- If the current user is not an admin, return false (action not allowed)
    IF NOT v_is_admin THEN
        RETURN QUERY SELECT FALSE, 'Not authorized'::TEXT, NULL::TEXT;
        RETURN;
    END IF;
    
    -- Get the role ID for the given role name
    SELECT id INTO v_role_id FROM roles WHERE name = p_role_name;
    IF v_role_id IS NULL THEN
        RETURN QUERY SELECT FALSE, 'Invalid role name'::TEXT, NULL::TEXT;
        RETURN;
    END IF;
    
    -- Get or invite the user
    SELECT * INTO v_user_info FROM get_or_invite_user(p_merchant_id, p_email, p_role_name);
    
    -- Perform the requested action
    CASE p_action
        WHEN 'add' THEN
            IF v_user_info.is_new THEN
                RETURN QUERY SELECT TRUE, 'Invitation sent'::TEXT, v_user_info.invitation_token;
            ELSE
                -- Add the user to the merchant if not already added
                INSERT INTO merchant_users (merchant_id, user_id)
                VALUES (p_merchant_id, v_user_info.user_id)
                ON CONFLICT DO NOTHING;
                
                -- Add or update the user's role
                INSERT INTO user_roles (merchant_id, user_id, role_id)
                VALUES (p_merchant_id, v_user_info.user_id, v_role_id)
                ON CONFLICT (merchant_id, user_id, role_id) 
                DO UPDATE SET role_id = EXCLUDED.role_id;
                
                RETURN QUERY SELECT TRUE, 'User added'::TEXT, NULL::TEXT;
            END IF;
            
        WHEN 'update' THEN
            IF v_user_info.is_new THEN
                RETURN QUERY SELECT FALSE, 'User not found'::TEXT, NULL::TEXT;
            ELSE
                -- Update the user's role
                UPDATE user_roles
                SET role_id = v_role_id
                WHERE merchant_id = p_merchant_id AND user_id = v_user_info.user_id;
                
                RETURN QUERY SELECT TRUE, 'Role updated'::TEXT, NULL::TEXT;
            END IF;
            
        WHEN 'remove' THEN
            IF v_user_info.is_new THEN
                RETURN QUERY SELECT FALSE, 'User not found'::TEXT, NULL::TEXT;
            ELSE
                -- Remove the user's role
                DELETE FROM user_roles
                WHERE merchant_id = p_merchant_id AND user_id = v_user_info.user_id;
                
                -- Remove the user from the merchant
                DELETE FROM merchant_users
                WHERE merchant_id = p_merchant_id AND user_id = v_user_info.user_id;
                
                RETURN QUERY SELECT TRUE, 'User removed'::TEXT, NULL::TEXT;
            END IF;
            
        ELSE
            RETURN QUERY SELECT FALSE, 'Invalid action'::TEXT, NULL::TEXT;
    END CASE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;