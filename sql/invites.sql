-- RPC Functions for invite management

-- Function to check pending invites for the current user
CREATE OR REPLACE FUNCTION check_invites()
RETURNS TABLE (
    invite_id uuid,
    entity_id uuid,
    entity_name text,
    invited_by_name text,
    role text,
    created_at timestamptz
) 
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    current_user_email text;
BEGIN
    -- Get current user's email
    SELECT auth.jwt() ->> 'email' INTO current_user_email;
    
    IF current_user_email IS NULL THEN
        RAISE EXCEPTION 'No authenticated user found';
    END IF;
    
    RETURN QUERY
    SELECT 
        ei.id as invite_id,
        ei.entity_id,
        e.name as entity_name,
        p.full_name as invited_by_name,
        ei.role,
        ei.created_at
    FROM entity_invites ei
    JOIN entities e ON ei.entity_id = e.id
    JOIN profiles p ON ei.invited_by = p.id
    WHERE ei.email = current_user_email 
    AND ei.status = 'pending'
    ORDER BY ei.created_at DESC;
END;
$$;

-- Function to respond to invitations (accept or reject)
CREATE OR REPLACE FUNCTION respond_invitation(
    p_entity_id uuid,
    p_accept boolean
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    current_user_email text;
    current_user_id uuid;
    invite_record entity_invites%ROWTYPE;
    result json;
BEGIN
    -- Get current user info
    SELECT auth.jwt() ->> 'email' INTO current_user_email;
    SELECT auth.uid() INTO current_user_id;
    
    IF current_user_email IS NULL OR current_user_id IS NULL THEN
        RETURN json_build_object(
            'success', false,
            'error', 'No authenticated user found'
        );
    END IF;
    
    -- Find the pending invite
    SELECT * INTO invite_record
    FROM entity_invites 
    WHERE entity_id = p_entity_id 
    AND email = current_user_email 
    AND status = 'pending';
    
    IF NOT FOUND THEN
        RETURN json_build_object(
            'success', false,
            'error', 'No pending invitation found for this entity'
        );
    END IF;
    
    IF p_accept THEN
        -- Accept invitation
        UPDATE entity_invites 
        SET status = 'accepted', updated_at = now()
        WHERE id = invite_record.id;
        
        -- Add user to entity members
        INSERT INTO entity_members (entity_id, profile_id, role)
        VALUES (p_entity_id, current_user_id, invite_record.role)
        ON CONFLICT (entity_id, profile_id) DO NOTHING;
        
        result := json_build_object(
            'success', true,
            'message', 'Invitation accepted successfully'
        );
    ELSE
        -- Reject invitation
        UPDATE entity_invites 
        SET status = 'rejected', updated_at = now()
        WHERE id = invite_record.id;
        
        result := json_build_object(
            'success', true,
            'message', 'Invitation rejected'
        );
    END IF;
    
    RETURN result;
EXCEPTION WHEN others THEN
    RETURN json_build_object(
        'success', false,
        'error', SQLERRM
    );
END;
$$;

-- Function to send invitations
CREATE OR REPLACE FUNCTION send_invitation(
    p_entity_id uuid,
    p_email text,
    p_role text DEFAULT 'viewer'
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    current_user_id uuid;
    entity_exists boolean;
    user_is_member boolean;
    invite_exists boolean;
    result json;
BEGIN
    -- Get current user
    SELECT auth.uid() INTO current_user_id;
    
    IF current_user_id IS NULL THEN
        RETURN json_build_object(
            'success', false,
            'error', 'No authenticated user found'
        );
    END IF;
    
    -- Validate role
    IF p_role NOT IN ('owner', 'editor', 'viewer') THEN
        RETURN json_build_object(
            'success', false,
            'error', 'Invalid role. Must be owner, editor, or viewer'
        );
    END IF;
    
    -- Check if entity exists
    SELECT EXISTS(SELECT 1 FROM entities WHERE id = p_entity_id) INTO entity_exists;
    
    IF NOT entity_exists THEN
        RETURN json_build_object(
            'success', false,
            'error', 'Entity not found'
        );
    END IF;
    
    -- Check if current user is a member of the entity
    SELECT EXISTS(
        SELECT 1 FROM entity_members 
        WHERE entity_id = p_entity_id AND profile_id = current_user_id
    ) INTO user_is_member;
    
    IF NOT user_is_member THEN
        RETURN json_build_object(
            'success', false,
            'error', 'You are not a member of this entity'
        );
    END IF;
    
    -- Check if invite already exists
    SELECT EXISTS(
        SELECT 1 FROM entity_invites 
        WHERE entity_id = p_entity_id 
        AND email = p_email 
        AND status = 'pending'
    ) INTO invite_exists;
    
    IF invite_exists THEN
        RETURN json_build_object(
            'success', false,
            'error', 'A pending invitation already exists for this email'
        );
    END IF;
    
    -- Check if user is already a member
    SELECT EXISTS(
        SELECT 1 FROM entity_members em
        JOIN profiles p ON em.profile_id = p.id
        WHERE em.entity_id = p_entity_id AND p.email = p_email
    ) INTO invite_exists;
    
    IF invite_exists THEN
        RETURN json_build_object(
            'success', false,
            'error', 'User is already a member of this entity'
        );
    END IF;
    
    -- Create invitation
    INSERT INTO entity_invites (entity_id, email, invited_by, role, status)
    VALUES (p_entity_id, p_email, current_user_id, p_role, 'pending');
    
    RETURN json_build_object(
        'success', true,
        'message', 'Invitation sent successfully'
    );
    
EXCEPTION WHEN others THEN
    RETURN json_build_object(
        'success', false,
        'error', SQLERRM
    );
END;
$$; 