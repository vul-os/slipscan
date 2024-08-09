CREATE OR REPLACE FUNCTION create_simple_payment(
    p_merchant_id UUID,
    p_customer_name TEXT,
    p_customer_email TEXT,
    p_customer_phone TEXT,
    p_total_amount DECIMAL(10, 2),
    p_currency TEXT DEFAULT 'ZAR',
    p_payment_method TEXT DEFAULT 'PayShap'
) RETURNS TABLE (payment_id UUID, session_token TEXT, customer_id UUID, payment_code TEXT) AS $$
DECLARE
    v_customer_id UUID;
    v_payment_group_id UUID;
    v_payment_id UUID;
    v_token TEXT;
    v_auth_uid UUID;
    v_payment_code TEXT;
    v_payment_code_id UUID;
    v_existing_payment_group_id UUID;
BEGIN
    -- Get the authenticated user ID if available
    v_auth_uid := auth.uid();

    -- Step 1: Create or fetch the customer
    IF v_auth_uid IS NOT NULL THEN
        -- Authenticated user
        SELECT id INTO v_customer_id
        FROM public.profiles
        WHERE id = v_auth_uid;

        -- Ensure the customer exists in the customers table
        IF NOT EXISTS (SELECT 1 FROM customers WHERE id = v_customer_id) THEN
            INSERT INTO customers (id, name, email, phone)
            VALUES (v_customer_id, p_customer_name, p_customer_email, p_customer_phone);
        ELSE
            -- Update customer information if it has changed
            UPDATE customers
            SET name = COALESCE(p_customer_name, name),
                email = COALESCE(p_customer_email, email),
                phone = COALESCE(p_customer_phone, phone)
            WHERE id = v_customer_id;
        END IF;
    ELSE
        -- Anonymous user
        SELECT id INTO v_customer_id
        FROM customers
        WHERE email = p_customer_email AND phone = p_customer_phone;

        IF v_customer_id IS NULL THEN
            INSERT INTO customers (name, email, phone)
            VALUES (p_customer_name, p_customer_email, p_customer_phone)
            RETURNING id INTO v_customer_id;
        ELSE
            -- Update customer information if it has changed
            UPDATE customers
            SET name = COALESCE(p_customer_name, name)
            WHERE id = v_customer_id;
        END IF;
    END IF;

    -- Ensure the customer is associated with the merchant
    INSERT INTO customer_merchants (customer_id, merchant_id)
    VALUES (v_customer_id, p_merchant_id)
    ON CONFLICT DO NOTHING;

    -- Check if there's an existing pending payment group for this customer and merchant
    SELECT pg.id INTO v_existing_payment_group_id
    FROM payment_groups pg
    JOIN customer_merchants cm ON pg.customer_id = cm.customer_id
    WHERE cm.merchant_id = p_merchant_id
      AND pg.customer_id = v_customer_id
      AND pg.status = 'pending'
    ORDER BY pg.created_at DESC
    LIMIT 1;

    IF v_existing_payment_group_id IS NOT NULL THEN
        -- Use the existing payment group
        v_payment_group_id := v_existing_payment_group_id;
        
        -- Update the existing payment group
        UPDATE payment_groups
        SET total_amount = p_total_amount
        WHERE id = v_payment_group_id;

        -- Update or create a payment for this group
        UPDATE payments
        SET amount_charged = p_total_amount,
            payment_method = p_payment_method,
            updated_at = CURRENT_TIMESTAMP
        WHERE payment_group_id = v_payment_group_id
        RETURNING id INTO v_payment_id;

        IF v_payment_id IS NULL THEN
            INSERT INTO payments (payment_group_id, amount_charged, status, payment_method, customer_id)
            VALUES (v_payment_group_id, p_total_amount, 'pending', p_payment_method, v_customer_id)
            RETURNING id INTO v_payment_id;
        END IF;

        -- Deactivate the old payment code
        UPDATE payment_codes
        SET status = 'inactive'
        WHERE id IN (
            SELECT payment_code_id
            FROM payment_code_groups
            WHERE payment_group_id = v_payment_group_id
        );
    ELSE
        -- Create a new payment group with status 'pending'
        INSERT INTO payment_groups (customer_id, total_amount, status)
        VALUES (v_customer_id, p_total_amount, 'pending')
        RETURNING id INTO v_payment_group_id;

        -- Create a new payment with status 'pending'
        INSERT INTO payments (payment_group_id, amount_charged, status, payment_method, customer_id)
        VALUES (v_payment_group_id, p_total_amount, 'pending', p_payment_method, v_customer_id)
        RETURNING id INTO v_payment_id;
    END IF;

    -- Generate a new unique payment code
    v_payment_code := find_unique_payment_code();

    -- The payment code is already inserted, so we just need to link it
    SELECT id INTO v_payment_code_id
    FROM payment_codes
    WHERE code = v_payment_code;

    -- Link the payment code to the payment group
    INSERT INTO payment_code_groups (payment_code_id, payment_group_id)
    VALUES (v_payment_code_id, v_payment_group_id);

    -- Create or refresh a customer session
    SELECT token INTO v_token
    FROM create_customer_session(v_customer_id);

    -- Return the payment ID, session token, customer ID, and new payment code
    RETURN QUERY SELECT v_payment_id, v_token, v_customer_id, v_payment_code;
EXCEPTION
    WHEN others THEN
        -- If an error occurs, attempt to deactivate the payment code
        IF v_payment_code IS NOT NULL THEN
            UPDATE payment_codes SET status = 'inactive' WHERE code = v_payment_code;
        END IF;
        RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;