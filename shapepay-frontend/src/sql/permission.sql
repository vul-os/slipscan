-- File: 02-permission-system.sql
-- Description: Zanzibar-like permission system functions and setup

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

-- Function to revoke permission
CREATE OR REPLACE FUNCTION revoke_permission(
    p_revoker_id UUID,
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
        -- Directly revoke permission without checks
        DELETE FROM tuples
        WHERE namespace_id = (SELECT id FROM namespaces WHERE name = p_namespace)
        AND object_id = (SELECT id FROM objects WHERE namespace_id = (SELECT id FROM namespaces WHERE name = p_namespace) AND object_id = p_object_id)
        AND relation_id = (SELECT id FROM relations WHERE namespace_id = (SELECT id FROM namespaces WHERE name = p_namespace) AND name = p_relation)
        AND user_id = p_user_id;

        -- Invalidate cache
        DELETE FROM permission_cache
        WHERE object_id = (SELECT id FROM objects WHERE namespace_id = (SELECT id FROM namespaces WHERE name = p_namespace) AND object_id = p_object_id)
        AND user_id = p_user_id;

        RETURN;
    END IF;

    -- Get namespace_id, object_id, and relation_id
    SELECT n.id, o.id, r.id INTO v_namespace_id, v_object_id, v_relation_id
    FROM namespaces n
    JOIN objects o ON n.id = o.namespace_id
    JOIN relations r ON n.id = r.namespace_id
    WHERE n.name = p_namespace AND o.object_id = p_object_id AND r.name = p_relation;

    IF v_namespace_id IS NULL OR v_object_id IS NULL OR v_relation_id IS NULL THEN
        RAISE EXCEPTION 'Namespace, object, or relation not found';
    END IF;

    -- Check if revoker has permission to revoke
    IF NOT check_permission(p_revoker_id, p_namespace, p_object_id, 'revoke_' || p_relation) THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    -- Revoke permission
    DELETE FROM tuples
    WHERE namespace_id = v_namespace_id
    AND object_id = v_object_id
    AND relation_id = v_relation_id
    AND user_id = p_user_id;

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

-- Initialize basic namespaces, relations, and permissions
DO $$
BEGIN
    -- Insert namespaces
    INSERT INTO namespaces (name) VALUES 
    ('merchant'), ('customer'), ('payment'), ('payout')
    ON CONFLICT (name) DO NOTHING;

    -- Insert relations
    INSERT INTO relations (namespace_id, name)
    SELECT id, 'owner' FROM namespaces WHERE name = 'merchant'
    ON CONFLICT (namespace_id, name) DO NOTHING;

    INSERT INTO relations (namespace_id, name)
    SELECT id, 'viewer' FROM namespaces WHERE name = 'merchant'
    ON CONFLICT (namespace_id, name) DO NOTHING;

    INSERT INTO relations (namespace_id, name)
    SELECT id, 'owner' FROM namespaces WHERE name = 'customer'
    ON CONFLICT (namespace_id, name) DO NOTHING;

    INSERT INTO relations (namespace_id, name)
    SELECT id, 'viewer' FROM namespaces WHERE name = 'payment'
    ON CONFLICT (namespace_id, name) DO NOTHING;

    INSERT INTO relations (namespace_id, name)
    SELECT id, 'viewer' FROM namespaces WHERE name = 'payout'
    ON CONFLICT (namespace_id, name) DO NOTHING;

    -- Insert permissions
    INSERT INTO permissions (namespace_id, relation_id, permission)
    SELECT n.id, r.id, 'view'
    FROM namespaces n
    JOIN relations r ON n.id = r.namespace_id
    WHERE n.name = 'merchant' AND r.name = 'owner'
    ON CONFLICT (namespace_id, relation_id, permission) DO NOTHING;

    INSERT INTO permissions (namespace_id, relation_id, permission)
    SELECT n.id, r.id, 'edit'
    FROM namespaces n
    JOIN relations r ON n.id = r.namespace_id
    WHERE n.name = 'merchant' AND r.name = 'owner'
    ON CONFLICT (namespace_id, relation_id, permission) DO NOTHING;

    INSERT INTO permissions (namespace_id, relation_id, permission)
    SELECT n.id, r.id, 'view'
    FROM namespaces n
    JOIN relations r ON n.id = r.namespace_id
    WHERE n.name = 'merchant' AND r.name = 'viewer'
    ON CONFLICT (namespace_id, relation_id, permission) DO NOTHING;

    INSERT INTO permissions (namespace_id, relation_id, permission)
    SELECT n.id, r.id, 'view'
    FROM namespaces n
    JOIN relations r ON n.id = r.namespace_id
    WHERE n.name = 'customer' AND r.name = 'owner'
    ON CONFLICT (namespace_id, relation_id, permission) DO NOTHING;

    INSERT INTO permissions (namespace_id, relation_id, permission)
    SELECT n.id, r.id, 'edit'
    FROM namespaces n
    JOIN relations r ON n.id = r.namespace_id
    WHERE n.name = 'customer' AND r.name = 'owner'
    ON CONFLICT (namespace_id, relation_id, permission) DO NOTHING;

    INSERT INTO permissions (namespace_id, relation_id, permission)
    SELECT n.id, r.id, 'view'
    FROM namespaces n
    JOIN relations r ON n.id = r.namespace_id
    WHERE n.name = 'payment' AND r.name = 'viewer'
    ON CONFLICT (namespace_id, relation_id, permission) DO NOTHING;

    INSERT INTO permissions (namespace_id, relation_id, permission)
    SELECT n.id, r.id, 'view'
    FROM namespaces n
    JOIN relations r ON n.id = r.namespace_id
    WHERE n.name = 'payout' AND r.name = 'viewer'
    ON CONFLICT (namespace_id, relation_id, permission) DO NOTHING;
END $$;

-- Allow service_role full access to transaction_codes
CREATE POLICY "Allow service_role full access on transaction_codes" ON transaction_codes
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

-- Allow merchants to access their own transaction codes
CREATE POLICY "Allow merchant to access own transaction codes" ON transaction_codes
    USING (
        payment_group_id IN (
            SELECT pg.id 
            FROM payment_groups pg
            JOIN txns t ON pg.txn_id = t.id
            JOIN merchants m ON t.merchant_id = m.id
            WHERE m.profile_id = auth.uid()
        )
        OR
        bank_transaction_id IN (
            SELECT bt.id
            FROM bank_transactions bt
            JOIN bank_accounts ba ON bt.bank_account_id = ba.id
            JOIN merchants m ON ba.merchant_id = m.id
            WHERE m.profile_id = auth.uid()
        )
    );