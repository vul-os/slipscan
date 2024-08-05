-- Enable RLS on all tables that require access control
ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE txns ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payshap_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE unmatched_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE namespaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tuples ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Policy for merchants: allow access based on Zanzibar permissions
CREATE POLICY merchant_access_policy ON merchants
USING (
    check_permission(auth.uid(), 'merchant', id::TEXT, 'view')
);

-- Policy for merchant_users: allow access based on Zanzibar permissions
CREATE POLICY merchant_user_access_policy ON merchant_users
USING (
    check_permission(auth.uid(), 'merchant', merchant_id::TEXT, 'manage_users')
);

-- Policy for customers: allow access based on Zanzibar permissions
CREATE POLICY customer_access_policy ON customers
USING (
    check_permission(auth.uid(), 'customer', id::TEXT, 'view')
);

-- Policy for transactions: allow access based on Zanzibar permissions
CREATE POLICY txn_access_policy ON txns
USING (
    check_permission(auth.uid(), 'transaction', id::TEXT, 'view')
);

-- Policy for payments: allow access based on Zanzibar permissions
CREATE POLICY payment_access_policy ON payments
USING (
    check_permission(auth.uid(), 'payment', id::TEXT, 'view')
);

-- Policy for bank_accounts: allow access based on Zanzibar permissions
CREATE POLICY bank_account_access_policy ON bank_accounts
USING (
    check_permission(auth.uid(), 'bank_account', id::TEXT, 'view')
);

-- Policy for bank_transactions: allow access based on Zanzibar permissions
CREATE POLICY bank_transaction_access_policy ON bank_transactions
USING (
    check_permission(auth.uid(), 'bank_transaction', id::TEXT, 'view')
);

-- Policy for refunds: allow access based on Zanzibar permissions
CREATE POLICY refund_access_policy ON refunds
USING (
    check_permission(auth.uid(), 'refund', id::TEXT, 'view')
);

-- Policy for payouts: allow access based on Zanzibar permissions
CREATE POLICY payout_access_policy ON payouts
USING (
    check_permission(auth.uid(), 'payout', id::TEXT, 'view')
);

-- Policy for payshap_targets: allow access based on Zanzibar permissions
CREATE POLICY payshap_target_access_policy ON payshap_targets
USING (
    check_permission(auth.uid(), 'payshap_target', id::TEXT, 'view')
);

-- Policy for payment_groups: allow access based on Zanzibar permissions
CREATE POLICY payment_group_access_policy ON payment_groups
USING (
    check_permission(auth.uid(), 'payment_group', id::TEXT, 'view')
);

-- Policy for webhooks: allow access based on Zanzibar permissions
CREATE POLICY webhook_access_policy ON webhooks
USING (
    check_permission(auth.uid(), 'webhook', id::TEXT, 'view')
);

-- Policy for api_keys: allow access based on Zanzibar permissions
CREATE POLICY api_key_access_policy ON api_keys
USING (
    check_permission(auth.uid(), 'api_key', id::TEXT, 'view')
);

-- Policy for unmatched_transactions: allow access based on Zanzibar permissions
CREATE POLICY unmatched_transaction_access_policy ON unmatched_transactions
USING (
    check_permission(auth.uid(), 'unmatched_transaction', id::TEXT, 'view')
);

-- Policy for reconciliation_log: allow access based on Zanzibar permissions
CREATE POLICY reconciliation_log_access_policy ON reconciliation_log
USING (
    check_permission(auth.uid(), 'reconciliation_log', id::TEXT, 'view')
);

-- Policy for transaction_codes: allow access based on Zanzibar permissions
CREATE POLICY transaction_code_access_policy ON transaction_codes
USING (
    check_permission(auth.uid(), 'transaction_code', id::TEXT, 'view')
);

-- Policy for customer_sessions: allow access based on Zanzibar permissions
CREATE POLICY customer_session_access_policy ON customer_sessions
USING (
    check_permission(auth.uid(), 'customer_session', id::TEXT, 'view')
);

-- Policy for audit_log: allow access based on Zanzibar permissions
CREATE POLICY audit_log_access_policy ON audit_log
USING (
    check_permission(auth.uid(), 'audit_log', table_name::TEXT, 'view')
);

-- Policy for merchant_roles: allow access based on Zanzibar permissions
CREATE POLICY merchant_roles_access_policy ON merchant_roles
USING (
    check_permission(auth.uid(), 'merchant_roles', id::TEXT, 'view')
);

-- Policy for namespaces: allow access based on Zanzibar permissions
CREATE POLICY namespaces_access_policy ON namespaces
USING (
    check_permission(auth.uid(), 'namespace', id::TEXT, 'view')
);

-- Policy for objects: allow access based on Zanzibar permissions
CREATE POLICY objects_access_policy ON objects
USING (
    check_permission(auth.uid(), 'object', id::TEXT, 'view')
);

-- Policy for permission_cache: allow access based on Zanzibar permissions
CREATE POLICY permission_cache_access_policy ON permission_cache
USING (
    check_permission(auth.uid(), 'permission_cache', id::TEXT, 'view')
);

-- Policy for relations: allow access based on Zanzibar permissions
CREATE POLICY relations_access_policy ON relations
USING (
    check_permission(auth.uid(), 'relation', id::TEXT, 'view')
);

-- Policy for tuples: allow access based on Zanzibar permissions
CREATE POLICY tuples_access_policy ON tuples
USING (
    check_permission(auth.uid(), 'tuple', id::TEXT, 'view')
);

-- Policy for profiles: allow access to profiles linked to the merchant only
CREATE POLICY profiles_access_policy ON profiles
USING (
    EXISTS (
        SELECT 1 FROM merchant_users
        WHERE merchant_users.user_id = profiles.id
        AND check_permission(auth.uid(), 'merchant', merchant_users.merchant_id::TEXT, 'view')
    )
);

-- Force the use of RLS policies
ALTER TABLE merchants FORCE ROW LEVEL SECURITY;
ALTER TABLE merchant_users FORCE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
ALTER TABLE txns FORCE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE refunds FORCE ROW LEVEL SECURITY;
ALTER TABLE payouts FORCE ROW LEVEL SECURITY;
ALTER TABLE payshap_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE webhooks FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE unmatched_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_log FORCE ROW LEVEL SECURITY;
ALTER TABLE transaction_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE merchant_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE namespaces FORCE ROW LEVEL SECURITY;
ALTER TABLE objects FORCE ROW LEVEL SECURITY;
ALTER TABLE permission_cache FORCE ROW LEVEL SECURITY;
ALTER TABLE relations FORCE ROW LEVEL SECURITY;
ALTER TABLE tuples FORCE ROW LEVEL SECURITY;
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;
