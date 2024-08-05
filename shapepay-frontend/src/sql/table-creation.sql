-- File: 01-table-creation.sql
-- Description: Creation of all tables for the payment system

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create merchants table
CREATE TABLE merchants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profile_id UUID REFERENCES profiles(id),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    handle TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create merchant_roles table
CREATE TABLE merchant_roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT UNIQUE NOT NULL
);

-- Insert default roles
INSERT INTO merchant_roles (name) VALUES ('admin'), ('viewer');

-- Create merchant_users table
CREATE TABLE merchant_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID REFERENCES merchants(id),
    user_id UUID REFERENCES auth.users(id),
    role_id UUID REFERENCES merchant_roles(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (merchant_id, user_id)
);

-- Create customers table
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID REFERENCES merchants(id),
    phone TEXT NOT NULL,
    name TEXT,
    email TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (merchant_id, email)
);

-- Create payshap_targets table
CREATE TABLE payshap_targets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID REFERENCES merchants(id),
    account_name TEXT NOT NULL,
    account_number TEXT NOT NULL,
    bank_name TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (merchant_id, account_number)
);

-- Create txns table
CREATE TABLE txns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID REFERENCES merchants(id),
    customer_id UUID REFERENCES customers(id),
    txn_number TEXT NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    currency TEXT DEFAULT 'ZAR',
    status TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (merchant_id, txn_number)
);

-- Create payment_groups table
CREATE TABLE payment_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    txn_id UUID REFERENCES txns(id),
    external_reference_id TEXT,
    total_amount DECIMAL(10, 2) NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create bank_accounts table
CREATE TABLE bank_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID REFERENCES merchants(id),
    bank_name TEXT NOT NULL,
    account_number TEXT NOT NULL,
    account_holder TEXT NOT NULL,
    encrypted_username TEXT NOT NULL,
    encrypted_password TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (merchant_id, account_number)
);

-- Create bank_transactions table
CREATE TABLE bank_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_account_id UUID REFERENCES bank_accounts(id),
    date TIMESTAMP WITH TIME ZONE NOT NULL,
    description TEXT,
    reference TEXT NOT NULL,
    service_fee DECIMAL(10, 2) DEFAULT 0.00,
    amount DECIMAL(10, 2) NOT NULL,
    balance DECIMAL(10, 2),
    detected_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create payments table
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_group_id UUID REFERENCES payment_groups(id),
    payshap_target_id UUID REFERENCES payshap_targets(id),
    payshap_transaction_id TEXT UNIQUE,
    amount_charged DECIMAL(10, 2) NOT NULL,
    amount_collected DECIMAL(10, 2) NOT NULL DEFAULT 0,
    amount_refunded DECIMAL(10, 2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    payment_method TEXT DEFAULT 'PayShap',
    bank_transaction_id UUID REFERENCES bank_transactions(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create refunds table
CREATE TABLE refunds (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    txn_id UUID REFERENCES txns(id),
    amount DECIMAL(10, 2) NOT NULL,
    payshap_refund_id TEXT UNIQUE,
    status TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create payouts table
CREATE TABLE payouts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID REFERENCES merchants(id),
    amount DECIMAL(10, 2) NOT NULL,
    status TEXT NOT NULL,
    payout_date TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create webhooks table
CREATE TABLE webhooks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID REFERENCES merchants(id),
    url TEXT NOT NULL,
    event_type TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create api_keys table
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    key_hash TEXT NOT NULL,
    key_salt TEXT NOT NULL,
    name TEXT,
    is_active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (merchant_id, key_hash)
);

-- Create audit_log table
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_name TEXT NOT NULL,
    record_id UUID NOT NULL,
    action TEXT NOT NULL,
    changed_fields JSONB,
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    changed_by UUID REFERENCES profiles(id)
);

-- Create unmatched_transactions table
CREATE TABLE unmatched_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    bank_transaction_id UUID REFERENCES bank_transactions(id),
    status TEXT NOT NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create reconciliation_log table
CREATE TABLE reconciliation_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_id UUID REFERENCES payments(id),
    bank_transaction_id UUID REFERENCES bank_transactions(id),
    reconciliation_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL,
    notes TEXT
);

-- Create transaction_codes table
CREATE TABLE transaction_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_group_id UUID REFERENCES payment_groups(id),
    bank_transaction_id UUID REFERENCES bank_transactions(id),
    code TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    UNIQUE (code)
);

-- Create customer_sessions table
CREATE TABLE customer_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID REFERENCES customers(id),
    token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tables for Zanzibar-like permission system
CREATE TABLE namespaces (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT UNIQUE NOT NULL
);

CREATE TABLE relations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    namespace_id UUID REFERENCES namespaces(id),
    name TEXT NOT NULL,
    UNIQUE (namespace_id, name)
);

CREATE TABLE objects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    namespace_id UUID REFERENCES namespaces(id),
    object_id TEXT NOT NULL,
    UNIQUE (namespace_id, object_id)
);

CREATE TABLE tuples (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    namespace_id UUID REFERENCES namespaces(id),
    object_id UUID REFERENCES objects(id),
    relation_id UUID REFERENCES relations(id),
    user_id UUID,  -- Assuming this references a user table
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (namespace_id, object_id, relation_id, user_id)
);

CREATE TABLE permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    namespace_id UUID REFERENCES namespaces(id),
    relation_id UUID REFERENCES relations(id),
    permission TEXT NOT NULL,
    UNIQUE (namespace_id, relation_id, permission)
);

CREATE TABLE permission_cache (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,  -- Assuming this references a user table
    object_id UUID REFERENCES objects(id),
    permission TEXT NOT NULL,
    result BOOLEAN NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, object_id, permission)
);

-- Create function to update modified column
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updating modified column
CREATE TRIGGER update_merchant_modtime
    BEFORE UPDATE ON merchants
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_customer_modtime
    BEFORE UPDATE ON customers
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_payshap_target_modtime
    BEFORE UPDATE ON payshap_targets
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_txn_modtime
    BEFORE UPDATE ON txns
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_payment_group_modtime
    BEFORE UPDATE ON payment_groups
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_bank_account_modtime
    BEFORE UPDATE ON bank_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_bank_transaction_modtime
    BEFORE UPDATE ON bank_transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_payment_modtime
    BEFORE UPDATE ON payments
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_refund_modtime
    BEFORE UPDATE ON refunds
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_payout_modtime
    BEFORE UPDATE ON payouts
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_webhook_modtime
    BEFORE UPDATE ON webhooks
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_api_key_modtime
    BEFORE UPDATE ON api_keys
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_unmatched_transaction_modtime
    BEFORE UPDATE ON unmatched_transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_merchant_user_modtime
    BEFORE UPDATE ON merchant_users
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_customer_session_modtime
    BEFORE UPDATE ON customer_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

-- Create indexes for faster lookups
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX idx_audit_log_table_record ON audit_log(table_name, record_id);
CREATE INDEX idx_reconciliation_log_payment ON reconciliation_log(payment_id);
CREATE INDEX idx_reconciliation_log_bank_transaction ON reconciliation_log(bank_transaction_id);
CREATE INDEX idx_bank_transactions_bank_account ON bank_transactions(bank_account_id);
CREATE INDEX idx_bank_transactions_date ON bank_transactions(date);
CREATE INDEX idx_payments_bank_transaction ON payments(bank_transaction_id);
CREATE INDEX idx_unmatched_transactions_bank_transaction ON unmatched_transactions(bank_transaction_id);
CREATE INDEX idx_transaction_codes_code ON transaction_codes(code);
CREATE INDEX idx_transaction_codes_payment_group ON transaction_codes(payment_group_id);
CREATE INDEX idx_transaction_codes_bank_transaction ON transaction_codes(bank_transaction_id);
CREATE INDEX idx_merchant_users_merchant_user ON merchant_users(merchant_id, user_id);
CREATE INDEX idx_merchant_users_user ON merchant_users(user_id);
CREATE INDEX idx_customer_sessions_token ON customer_sessions(token);