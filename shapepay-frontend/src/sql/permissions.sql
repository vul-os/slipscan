-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE payshap_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE txns ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE unmatched_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_code_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_merchants ENABLE ROW LEVEL SECURITY;

-- Create policies for each table

-- Merchants table
CREATE POLICY merchant_policy ON merchants
USING (id = public.get_user_merchant_id() OR public.get_user_role() = 'admin');

-- Customers table
CREATE POLICY customer_policy ON customers
USING (
    id IN (
        SELECT customer_id 
        FROM customer_merchants 
        WHERE merchant_id = public.get_user_merchant_id()
    ) 
    OR public.get_user_role() = 'admin'
);

-- Payshap_targets table
CREATE POLICY payshap_target_policy ON payshap_targets
USING (merchant_id = public.get_user_merchant_id() OR public.get_user_role() = 'admin');

-- Txns table
CREATE POLICY txn_policy ON txns
USING (merchant_id = public.get_user_merchant_id() OR public.get_user_role() = 'admin');

-- Payment_groups table
CREATE POLICY payment_group_policy ON payment_groups
USING (
    customer_id IN (
        SELECT customer_id 
        FROM customer_merchants 
        WHERE merchant_id = public.get_user_merchant_id()
    ) 
    OR public.get_user_role() = 'admin'
);

-- Payments table
CREATE POLICY payment_policy ON payments
USING (
    payment_group_id IN (
        SELECT pg.id 
        FROM payment_groups pg 
        JOIN customer_merchants cm ON pg.customer_id = cm.customer_id 
        WHERE cm.merchant_id = public.get_user_merchant_id()
    ) 
    OR public.get_user_role() = 'admin'
);

-- Refunds table
CREATE POLICY refund_policy ON refunds
USING (txn_id IN (SELECT id FROM txns WHERE merchant_id = public.get_user_merchant_id()) OR public.get_user_role() = 'admin');

-- Payouts table
CREATE POLICY payout_policy ON payouts
USING (merchant_id = public.get_user_merchant_id() OR public.get_user_role() = 'admin');

-- Webhooks table
CREATE POLICY webhook_policy ON webhooks
USING (merchant_id = public.get_user_merchant_id() OR public.get_user_role() = 'admin');

-- Api_keys table
CREATE POLICY api_key_policy ON api_keys
USING (merchant_id = public.get_user_merchant_id() OR public.get_user_role() = 'admin');

-- Audit_log table
CREATE POLICY audit_log_policy ON audit_log
USING (
    record_id::TEXT IN (
        SELECT id::TEXT FROM merchants WHERE id = public.get_user_merchant_id()
        UNION ALL
        SELECT id::TEXT FROM customers WHERE id IN (
            SELECT customer_id 
            FROM customer_merchants 
            WHERE merchant_id = public.get_user_merchant_id()
        )
        UNION ALL
        SELECT id::TEXT FROM txns WHERE merchant_id = public.get_user_merchant_id()
    ) 
    OR public.get_user_role() = 'admin'
);

-- Create the policy for payment_code_definitions
CREATE POLICY payment_code_definitions_policy ON payment_code_definitions
USING (public.get_user_role() = 'admin');

-- Create the policy for payment_codes
CREATE POLICY payment_code_policy ON payment_codes
USING (
    payment_id IN (
        SELECT p.id
        FROM payments p
        JOIN payment_groups pg ON p.payment_group_id = pg.id
        JOIN customer_merchants cm ON pg.customer_id = cm.customer_id
        WHERE cm.merchant_id = public.get_user_merchant_id()
    ) 
    OR public.get_user_role() = 'admin'
);

-- Customer_sessions table
CREATE POLICY customer_session_policy ON customer_sessions
USING (
    customer_id IN (
        SELECT id 
        FROM customers 
        WHERE id IN (
            SELECT customer_id 
            FROM customer_merchants 
            WHERE merchant_id = public.get_user_merchant_id()
        )
    ) 
    OR public.get_user_role() = 'admin'
);

-- Merchant_Users table policy
CREATE POLICY merchant_users_policy ON merchant_users
USING (
    merchant_id = public.get_user_merchant_id()
    OR public.get_user_role() = 'admin'
);

-- Customer_Merchants table policy
CREATE POLICY customer_merchants_policy ON customer_merchants
USING (
    merchant_id = public.get_user_merchant_id()
    OR public.get_user_role() = 'admin'
);

-- Note: No specific policy is created for bank_accounts as per your request

-- Grant necessary permissions
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_user_role TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_user_merchant_id TO supabase_auth_admin;

-- Grant SELECT permissions on necessary tables
GRANT SELECT ON public.profiles TO supabase_auth_admin;
GRANT SELECT ON public.merchants TO supabase_auth_admin;
GRANT SELECT ON public.customers TO supabase_auth_admin;
GRANT SELECT ON public.payshap_targets TO supabase_auth_admin;
GRANT SELECT ON public.txns TO supabase_auth_admin;
GRANT SELECT ON public.payment_groups TO supabase_auth_admin;
GRANT SELECT ON public.bank_accounts TO supabase_auth_admin;
GRANT SELECT ON public.bank_transactions TO supabase_auth_admin;
GRANT SELECT ON public.payments TO supabase_auth_admin;
GRANT SELECT ON public.refunds TO supabase_auth_admin;
GRANT SELECT ON public.payouts TO supabase_auth_admin;
GRANT SELECT ON public.webhooks TO supabase_auth_admin;
GRANT SELECT ON public.api_keys TO supabase_auth_admin;
GRANT SELECT ON public.audit_log TO supabase_auth_admin;
GRANT SELECT ON public.unmatched_transactions TO supabase_auth_admin;
GRANT SELECT ON public.reconciliation_log TO supabase_auth_admin;
GRANT SELECT ON public.payment_code_definitions TO supabase_auth_admin;
GRANT SELECT ON public.payment_codes TO supabase_auth_admin;
GRANT SELECT ON public.customer_sessions TO supabase_auth_admin;
GRANT SELECT ON public.roles TO supabase_auth_admin;
GRANT SELECT ON public.merchant_users TO supabase_auth_admin;
GRANT SELECT ON public.customer_merchants TO supabase_auth_admin;

-- Grant execute permissions to authenticated users and supabase_auth_admin
GRANT EXECUTE ON FUNCTION public.get_user_role TO authenticated, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.get_user_merchant_id TO authenticated, supabase_auth_admin;

-- Grant SELECT permissions to authenticated users
GRANT SELECT ON public.roles TO authenticated;
GRANT SELECT ON public.merchant_users TO authenticated;
GRANT SELECT ON public.customer_merchants TO authenticated;