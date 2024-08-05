DO $$
DECLARE
    merchant_id1 UUID;
    merchant_id2 UUID;
    main_merchant_user_id1 UUID;
    view_only_merchant_user_id1 UUID;
    main_merchant_user_id2 UUID;
    customer_user_id1 UUID;
    payshap_target_id1 UUID;
    payshap_target_id2 UUID;
    bank_account_id1 UUID;
    bank_account_id2 UUID;
    customer_id1 UUID;
    customer_id2 UUID;
    txn_id UUID;
    payment_group_id UUID;
    current_bank_transaction_id UUID; 
    payment_id UUID;
    transaction_code_id UUID;
    num_payments INT;
    generated_code TEXT;
    soundex_code TEXT;
    external_reference_id TEXT;
    total_amount DECIMAL(10,2);
    transaction_status TEXT;
    transaction_date TIMESTAMP;
    merchant_name1 TEXT;
    merchant_name2 TEXT;
    merchant_email1 TEXT;
    merchant_email2 TEXT;
    merchant_handle1 TEXT;
    merchant_handle2 TEXT;
    transactions_created INT := 0;
    payments_created INT := 0;
    refunds_created INT := 0;
BEGIN
    -- Ensure we have enough profiles
    IF (SELECT COUNT(*) FROM profiles) < 4 THEN
        RAISE EXCEPTION 'Not enough profiles in the database. Please create at least 4 profiles before running this script.';
    END IF;

    -- Get user IDs from profiles table
    SELECT id INTO main_merchant_user_id1 FROM profiles ORDER BY RANDOM() LIMIT 1;
    SELECT id INTO main_merchant_user_id2 FROM profiles WHERE id != main_merchant_user_id1 ORDER BY RANDOM() LIMIT 1;
    SELECT id INTO view_only_merchant_user_id1 FROM profiles WHERE id NOT IN (main_merchant_user_id1, main_merchant_user_id2) ORDER BY RANDOM() LIMIT 1;
    SELECT id INTO customer_user_id1 FROM profiles WHERE id NOT IN (main_merchant_user_id1, main_merchant_user_id2, view_only_merchant_user_id1) ORDER BY RANDOM() LIMIT 1;

    -- Generate UUIDs for merchants and related entities
    merchant_id1 := uuid_generate_v4();
    merchant_id2 := uuid_generate_v4();
    payshap_target_id1 := uuid_generate_v4();
    payshap_target_id2 := uuid_generate_v4();
    bank_account_id1 := uuid_generate_v4();
    bank_account_id2 := uuid_generate_v4();

    -- Generate unique merchant names, emails, and handles
    merchant_name1 := 'ABC Trading Co. ' || substr(md5(random()::text), 1, 6);
    merchant_name2 := 'XYZ Trading Co. ' || substr(md5(random()::text), 1, 6);
    merchant_email1 := 'contact_' || substr(md5(random()::text), 1, 6) || '@abctrading.com';
    merchant_email2 := 'contact_' || substr(md5(random()::text), 1, 6) || '@xyztrading.com';
    merchant_handle1 := 'abc_' || substr(md5(random()::text), 1, 6);
    merchant_handle2 := 'xyz_' || substr(md5(random()::text), 1, 6);

    -- Insert merchants
    BEGIN
        INSERT INTO merchants (id, profile_id, name, email, phone, handle)
        VALUES 
            (merchant_id1, main_merchant_user_id1, merchant_name1, merchant_email1, '+27 11 123 4567', merchant_handle1),
            (merchant_id2, main_merchant_user_id2, merchant_name2, merchant_email2, '+27 11 987 6543', merchant_handle2);
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'Merchant already exists, skipping insertion';
    END;

    -- Set up permissions
    BEGIN
        PERFORM initialize_merchant_permissions(merchant_id1, main_merchant_user_id1);
        PERFORM initialize_merchant_permissions(merchant_id2, main_merchant_user_id2);
        PERFORM grant_permission(main_merchant_user_id1, 'merchant', merchant_id1::text, 'viewer', view_only_merchant_user_id1);
    EXCEPTION WHEN others THEN
        RAISE NOTICE 'Error setting up permissions: %', SQLERRM;
    END;

    -- Insert payshap_targets
    BEGIN
        INSERT INTO payshap_targets (id, merchant_id, account_name, account_number, bank_name)
        VALUES 
            (payshap_target_id1, merchant_id1, merchant_name1, '1234' || substr(md5(random()::text), 1, 6), 'First National Bank'),
            (payshap_target_id2, merchant_id2, merchant_name2, '0987' || substr(md5(random()::text), 1, 6), 'Standard Bank');
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'PayShap target already exists, skipping insertion';
    END;

    -- Insert bank_accounts
    BEGIN
        INSERT INTO bank_accounts (id, merchant_id, bank_name, account_number, account_holder, encrypted_username, encrypted_password)
        VALUES 
            (bank_account_id1, merchant_id1, 'First National Bank', '1234' || substr(md5(random()::text), 1, 6), merchant_name1, 'encrypted_username_1', 'encrypted_password_1'),
            (bank_account_id2, merchant_id2, 'Standard Bank', '0987' || substr(md5(random()::text), 1, 6), merchant_name2, 'encrypted_username_2', 'encrypted_password_2');
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'Bank account already exists, skipping insertion';
    END;

    -- Insert customers
    BEGIN
        customer_id1 := uuid_generate_v4();
        customer_id2 := uuid_generate_v4();
        INSERT INTO customers (id, merchant_id, name, email, phone)
        VALUES 
            (customer_id1, merchant_id1, 'Sample Customer 1', 'customer1_' || substr(md5(random()::text), 1, 6) || '@example.com', '+27 80 123 4567'),
            (customer_id2, merchant_id2, 'Sample Customer 2', 'customer2_' || substr(md5(random()::text), 1, 6) || '@example.com', '+27 80 987 6543');
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'Customer already exists, skipping insertion';
    END;
    
    -- Set up customer permissions
    BEGIN
        PERFORM grant_permission(main_merchant_user_id1, 'customer', customer_id1::text, 'owner', customer_user_id1);
    EXCEPTION WHEN others THEN
        RAISE NOTICE 'Error setting up customer permission: %', SQLERRM;
    END;

    -- Insert transactions and related data for both merchants
    FOR merchant_num IN 1..2 LOOP
        FOR j IN 1..50 LOOP  -- 50 transactions per merchant
            BEGIN
                txn_id := uuid_generate_v4();
                payment_group_id := uuid_generate_v4();
                
                -- Generate more varied transaction data
                total_amount := (random() * 10000 + 100)::numeric(10,2);
                transaction_status := CASE 
                    WHEN random() < 0.7 THEN 'completed'
                    WHEN random() < 0.9 THEN 'pending'
                    ELSE 'failed'
                END;
                transaction_date := CURRENT_TIMESTAMP - (random() * interval '90 days');
                
                -- Insert transaction
                INSERT INTO txns (id, merchant_id, customer_id, txn_number, total_amount, status, type, created_at)
                VALUES (
                    txn_id, 
                    CASE WHEN merchant_num = 1 THEN merchant_id1 ELSE merchant_id2 END,
                    CASE WHEN merchant_num = 1 THEN customer_id1 ELSE customer_id2 END,
                    'TXN' || merchant_num || lpad(j::text, 5, '0'), 
                    total_amount,
                    transaction_status,
                    CASE WHEN random() < 0.8 THEN 'order' ELSE 'subscription' END,
                    transaction_date
                );

                transactions_created := transactions_created + 1;
                
                -- Generate external reference ID
                external_reference_id := 'ORDER-' || merchant_num || lpad(j::text, 7, '0');
                
                -- Insert payment_group
                INSERT INTO payment_groups (id, txn_id, external_reference_id, total_amount, status, created_at)
                VALUES (
                    payment_group_id, txn_id, external_reference_id, 
                    total_amount, 
                    transaction_status,
                    transaction_date
                );
                
                -- Generate transaction code
                generated_code := 'CODE' || merchant_num || lpad(j::text, 7, '0');
                soundex_code := substring(generated_code from 1 for 1) || 
                                translate(substring(generated_code from 2), '0123456789', 'YZZYZYZYYY');
                
                -- Insert transaction code
                INSERT INTO transaction_codes (id, payment_group_id, code, soundex_code, status, expires_at, created_at)
                VALUES (
                    uuid_generate_v4(), payment_group_id, generated_code, soundex_code, 'active', transaction_date + interval '48 hours', transaction_date
                )
                RETURNING id INTO transaction_code_id;
                
                -- Insert payments and bank transactions
                num_payments := floor(random() * 3) + 1;  -- 1 to 3 payments per transaction
                FOR k IN 1..num_payments LOOP
                    current_bank_transaction_id := uuid_generate_v4();
                    payment_id := uuid_generate_v4();
                    
                    -- Insert bank_transaction
                    INSERT INTO bank_transactions (id, bank_account_id, date, description, reference, amount, balance)
                    VALUES (
                        current_bank_transaction_id, 
                        CASE WHEN merchant_num = 1 THEN bank_account_id1 ELSE bank_account_id2 END,
                        transaction_date + (random() * interval '2 days'),
                        'Payment received CODE' || generated_code, 
                        'TXN' || merchant_num || lpad(j::text, 5, '0') || '-' || k,
                        total_amount / num_payments,
                        (random() * 100000 + 10000)::numeric(10,2)
                    );
                    
                    -- Insert payment
                    INSERT INTO payments (id, payment_group_id, payshap_target_id, payshap_transaction_id, amount_charged, amount_collected, status, bank_transaction_id, created_at)
                    VALUES (
                        payment_id, payment_group_id, 
                        CASE WHEN merchant_num = 1 THEN payshap_target_id1 ELSE payshap_target_id2 END,
                        'PAYSHAP' || merchant_num || lpad(j::text, 5, '0') || '-' || k,
                        total_amount / num_payments,
                        CASE WHEN transaction_status = 'completed' THEN total_amount / num_payments ELSE 0 END,
                        transaction_status,
                        current_bank_transaction_id,
                        transaction_date + (random() * interval '2 days')
                    );

                    payments_created := payments_created + 1;
                    
                    -- Update transaction code
                    UPDATE transaction_codes
                    SET bank_transaction_id = current_bank_transaction_id,
                        status = 'used'
                    WHERE id = transaction_code_id;
                END LOOP;
                
                -- Insert refund (15% chance)
                IF random() < 0.15 THEN
                    INSERT INTO refunds (id, txn_id, amount, payshap_refund_id, status, reason, created_at)
                    VALUES (
                        uuid_generate_v4(), txn_id, 
                        total_amount * (random() * 0.8 + 0.1),
                        'REFUND' || merchant_num || lpad(j::text, 5, '0'),
                        CASE WHEN random() < 0.9 THEN 'completed' ELSE 'pending' END,
                        CASE 
                            WHEN random() < 0.4 THEN 'Customer request'
                            WHEN random() < 0.7 THEN 'Item out of stock'
                            ELSE 'Duplicate order'
                        END,
                        transaction_date + (random() * interval '7 days')
                    );
                    refunds_created := refunds_created + 1;
                END IF;
            EXCEPTION WHEN others THEN
                RAISE NOTICE 'Error creating transaction and related data: %', SQLERRM;
            END;
        END LOOP;

        -- Insert payouts (5 per merchant)
        FOR i IN 1..5 LOOP
            BEGIN
                INSERT INTO payouts (id, merchant_id, amount, status, payout_date, created_at)
                VALUES (
                    uuid_generate_v4(), 
                    CASE WHEN merchant_num = 1 THEN merchant_id1 ELSE merchant_id2 END,
                    (random() * 50000 + 5000)::numeric(10,2),
                    CASE 
                        WHEN random() < 0.8 THEN 'completed'
                        WHEN random() < 0.95 THEN 'pending'
                        ELSE 'failed'
                    END,
                    CURRENT_TIMESTAMP - (random() * interval '30 days'),
                    CURRENT_TIMESTAMP - (random() * interval '30 days')
                );
            EXCEPTION WHEN others THEN
                RAISE NOTICE 'Error creating payout: %', SQLERRM;
            END;
        END LOOP;
    END LOOP;

    -- Output summary
    RAISE NOTICE 'Dummy data generation complete:';
    RAISE NOTICE '- 2 merchants created';
    RAISE NOTICE '- % transactions created', transactions_created;
    RAISE NOTICE '- % payments created', payments_created;
    RAISE NOTICE '- % refunds created', refunds_created;
    RAISE NOTICE '- 10 payouts created (5 per merchant)';
EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Error in dummy data generation: %', SQLERRM;
END $$;