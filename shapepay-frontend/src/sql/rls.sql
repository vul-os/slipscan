-- File: 03-rls-and-security.sql
-- Description: Row Level Security policies and additional security configurations

-- Enable Row Level Security on all tables
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
ALTER TABLE transaction_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE namespaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tuples ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_cache ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for each table

-- Merchants table
CREATE POLICY "Allow service_role full access on merchants" ON merchants
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Allow authenticated users to view own merchant" ON merchants
    FOR SELECT
    USING (auth.uid() = profile_id);

-- Customers table
CREATE POLICY "Allow service_role full access on customers" ON customers
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Allow merchant to access own customers" ON customers
    USING (merchant_id IN (SELECT id FROM merchants WHERE profile_id = auth.uid()));

-- Transactions table
CREATE POLICY "Allow service_role full access on txns" ON txns
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Allow merchant to access own transactions" ON txns
    USING (merchant_id IN (SELECT id FROM merchants WHERE profile_id = auth.uid()));

-- Payment groups table
CREATE POLICY "Allow service_role full access on payment_groups" ON payment_groups
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Allow merchant to access own payment groups" ON payment_groups
    USING (txn_id IN (SELECT id FROM txns WHERE merchant_id IN (SELECT id FROM merchants WHERE profile_id = auth.uid())));

-- Payments table
CREATE POLICY "Allow service_role full access on payments" ON payments
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Allow merchant to access own payments" ON payments
    USING (payment_group_id IN (
        SELECT pg.id 
        FROM payment_groups pg
        JOIN txns t ON pg.txn_id = t.id
        JOIN merchants m ON t.merchant_id = m.id
        WHERE m.profile_id = auth.uid()
    ));

-- Add similar policies for other tables...

-- Function to handle new user creation
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, full_name, avatar_url)
    VALUES (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url');
    RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for new user creation
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Function to generate merchant handle from email
CREATE OR REPLACE FUNCTION generate_handle_from_email() 
RETURNS TRIGGER AS $$
BEGIN
    -- Generate handle by replacing non-alphanumeric characters with underscores
    NEW.handle := regexp_replace(split_part(NEW.email, '@', 1), '[^a-zA-Z0-9]', '_', 'g');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to generate merchant handle before insert
CREATE TRIGGER before_insert_merchant
BEFORE INSERT ON merchants
FOR EACH ROW
EXECUTE FUNCTION generate_handle_from_email();

-- Grant necessary privileges to the service_role
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Additional security measures can be added here, such as:
-- - Setting up audit triggers
-- - Implementing encryption for sensitive data
-- - Configuring connection security settings