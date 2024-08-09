-- Wrap statements in a single transaction
BEGIN;

-- Ensure the uuid-ossp extension is created
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Insert merchants
INSERT INTO merchants (id, name, email, phone, handle)
VALUES
    (uuid_generate_v4(), 'Merchant One', 'merchant1@example.com', '123-456-7890', 'merchantone'),
    (uuid_generate_v4(), 'Merchant Two', 'merchant2@example.com', '098-765-4321', 'merchanttwo')
ON CONFLICT (email) DO NOTHING;

-- Insert roles
INSERT INTO roles (id, name)
VALUES
    (uuid_generate_v4(), 'admin'),
    (uuid_generate_v4(), 'viewer')
ON CONFLICT (name) DO NOTHING;

-- Get the 4 profile IDs and merchant IDs
WITH profile_ids AS (
    SELECT id
    FROM public.profiles
    ORDER BY id
    LIMIT 4
), merchant_ids AS (
    SELECT id, name 
    FROM merchants 
    WHERE name IN ('Merchant One', 'Merchant Two')
    ORDER BY name
)
-- Link users to merchants and assign roles
INSERT INTO merchant_users (merchant_id, user_id)
SELECT 
    m.id AS merchant_id,
    p.id AS user_id
FROM 
    merchant_ids m
CROSS JOIN profile_ids p
WHERE 
    (m.name = 'Merchant One' AND p.id IN (SELECT id FROM profile_ids LIMIT 2))
    OR (m.name = 'Merchant Two' AND p.id IN (SELECT id FROM profile_ids OFFSET 2 LIMIT 2))
ON CONFLICT DO NOTHING;

-- Assign roles to users for specific merchants
INSERT INTO user_roles (merchant_id, user_id, role_id)
SELECT 
    mu.merchant_id,
    mu.user_id,
    CASE 
        WHEN ROW_NUMBER() OVER (PARTITION BY mu.merchant_id ORDER BY mu.user_id) = 1 THEN 
            (SELECT id FROM roles WHERE name = 'admin')
        ELSE 
            (SELECT id FROM roles WHERE name = 'viewer')
    END AS role_id
FROM 
    merchant_users mu
ON CONFLICT DO NOTHING;

-- Insert customers
INSERT INTO customers (id, name, email, phone)
VALUES
    (uuid_generate_v4(), 'Customer One', 'customer1@example.com', '111-111-1111'),
    (uuid_generate_v4(), 'Customer Two', 'customer2@example.com', '222-222-2222'),
    (uuid_generate_v4(), 'Customer Three', 'customer3@example.com', '333-333-3333'),
    (uuid_generate_v4(), 'Customer Four', 'customer4@example.com', '444-444-4444')
ON CONFLICT (email) DO NOTHING;

-- Link customers to merchants
INSERT INTO customer_merchants (customer_id, merchant_id)
SELECT c.id, m.id
FROM customers c
CROSS JOIN merchants m
WHERE 
    (c.name IN ('Customer One', 'Customer Two') AND m.name = 'Merchant One') OR
    (c.name IN ('Customer Three', 'Customer Four') AND m.name = 'Merchant Two')
ON CONFLICT DO NOTHING;

-- Create many transactions, payment groups, and payments
WITH 
transaction_data AS (
    SELECT 
        uuid_generate_v4() AS id,
        m.id AS merchant_id,
        c.id AS customer_id,
        'TXN-' || LEFT(m.id::text, 8) || '-' || gen.series AS txn_number,
        (random() * 1000 + 10)::numeric(10,2) AS total_amount,
        'ZAR' AS currency,
        (ARRAY['completed', 'pending', 'failed'])[floor(random() * 3 + 1)] AS status,
        'payment' AS type,
        now() - (random() * interval '90 days') AS created_at
    FROM 
        generate_series(1, 500) gen(series)
    CROSS JOIN 
        merchants m
    JOIN 
        customer_merchants cm ON m.id = cm.merchant_id
    JOIN 
        customers c ON cm.customer_id = c.id
)
INSERT INTO txns (id, merchant_id, customer_id, txn_number, total_amount, currency, status, type, created_at)
SELECT id, merchant_id, customer_id, txn_number, total_amount, currency, status, type, created_at
FROM transaction_data
ON CONFLICT (merchant_id, txn_number) DO NOTHING;

-- Create payment groups for each transaction
WITH payment_group_data AS (
    SELECT 
        uuid_generate_v4() AS id,
        t.id AS txn_id,
        'EXT-' || t.txn_number AS external_reference_id,
        t.total_amount,
        t.status,
        t.customer_id,
        t.created_at
    FROM 
        txns t
)
INSERT INTO payment_groups (id, txn_id, external_reference_id, total_amount, status, customer_id, created_at)
SELECT id, txn_id, external_reference_id, total_amount, status, customer_id, created_at
FROM payment_group_data
ON CONFLICT DO NOTHING;

-- Create payments for each payment group
WITH payment_data AS (
    SELECT 
        uuid_generate_v4() AS id,
        pg.id AS payment_group_id,
        NULL::uuid AS payshap_target_id, -- Cast NULL to UUID
        'PAYSHAP-' || pg.external_reference_id AS payshap_transaction_id,
        pg.total_amount AS amount_charged,
        CASE 
            WHEN pg.status = 'completed' THEN pg.total_amount
            WHEN pg.status = 'pending' THEN (random() * pg.total_amount)::numeric(10,2)
            ELSE 0
        END AS amount_collected,
        0 AS amount_refunded,
        pg.status,
        'PayShap' AS payment_method,
        NULL::uuid AS bank_transaction_id, -- Cast NULL to UUID
        pg.customer_id,
        pg.created_at
    FROM 
        payment_groups pg
)
INSERT INTO payments (id, payment_group_id, payshap_target_id, payshap_transaction_id, amount_charged, 
                      amount_collected, amount_refunded, status, payment_method, bank_transaction_id, 
                      customer_id, created_at)
SELECT id, payment_group_id, payshap_target_id, payshap_transaction_id, amount_charged, 
       amount_collected, amount_refunded, status, payment_method, bank_transaction_id, 
       customer_id, created_at
FROM payment_data
ON CONFLICT DO NOTHING;

-- Commit the transaction
COMMIT;