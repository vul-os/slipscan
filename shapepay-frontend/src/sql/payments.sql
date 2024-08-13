-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_payment_codes_status_code ON payment_codes (status, code);
CREATE INDEX IF NOT EXISTS idx_payment_codes_trgm ON payment_codes USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_payment_code_groups_payment_group_id ON payment_code_groups (payment_group_id);

-- Function to find a unique payment code
CREATE OR REPLACE FUNCTION find_unique_payment_code() RETURNS TEXT AS $$
DECLARE
    unique_code TEXT;
    max_attempts INTEGER := 50; -- Increased maximum number of attempts
    attempt INTEGER := 0;
BEGIN
    WHILE attempt < max_attempts LOOP
        -- Generate a new random code
        unique_code := upper(substring(md5(random()::text) from 1 for 6));
        
        -- Check if this code already exists
        IF NOT EXISTS (SELECT 1 FROM payment_codes WHERE code = unique_code) THEN
            -- Attempt to insert the new code
            BEGIN
                INSERT INTO payment_codes (code, status, expires_at)
                VALUES (unique_code, 'active', CURRENT_TIMESTAMP + INTERVAL '24 hours');
                
                -- If successful, return the code
                RETURN unique_code;
            EXCEPTION WHEN unique_violation THEN
                -- If a concurrent insert occurred, try again
            END;
        END IF;

        attempt := attempt + 1;
    END LOOP;

    -- If we've reached this point, we couldn't generate a unique code
    RAISE EXCEPTION 'Unable to generate a unique payment code after % attempts', max_attempts;
END;
$$ LANGUAGE plpgsql;


-- Function to generate new payment codes
CREATE OR REPLACE FUNCTION generate_payment_codes(num_codes INTEGER) RETURNS VOID AS $$
DECLARE
    new_code TEXT;
    attempt INTEGER;
BEGIN
    FOR i IN 1..num_codes LOOP
        attempt := 0;
        LOOP
            -- Generate a random 6-character code
            new_code := upper(substring(md5(random()::text) from 1 for 6));
            
            -- Try to insert the new code
            BEGIN
                INSERT INTO payment_codes (code, status, expires_at)
                VALUES (new_code, 'inactive', CURRENT_TIMESTAMP + INTERVAL '1 day');
                
                -- If successful, exit the loop
                EXIT;
            EXCEPTION WHEN unique_violation THEN
                -- If a duplicate code is generated, try again
                attempt := attempt + 1;
                IF attempt > 10 THEN
                    RAISE EXCEPTION 'Failed to generate a unique code after 10 attempts';
                END IF;
            END;
        END LOOP;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Function to validate and mark a code as used
CREATE OR REPLACE FUNCTION use_payment_code(p_code TEXT, p_payment_group_id UUID) RETURNS BOOLEAN AS $$
DECLARE
    found_code CHAR(6);
    found_payment_code_id UUID;
BEGIN
    -- Find and update the matching or similar code
    UPDATE payment_codes
    SET status = 'used', last_used_at = CURRENT_TIMESTAMP
    WHERE status = 'active'
    AND similarity(code, upper(p_code)) > 0.8
    AND expires_at > CURRENT_TIMESTAMP
    RETURNING id, code INTO found_payment_code_id, found_code;

    IF found_code IS NOT NULL THEN
        -- Link the payment code to the payment group
        INSERT INTO payment_code_groups (payment_code_id, payment_group_id)
        VALUES (found_payment_code_id, p_payment_group_id)
        ON CONFLICT (payment_code_id, payment_group_id) DO NOTHING;
    END IF;

    RETURN found_code IS NOT NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to mark a code as inactive
CREATE OR REPLACE FUNCTION mark_code_inactive(p_code TEXT) RETURNS VOID AS $$
BEGIN
    UPDATE payment_codes
    SET status = 'inactive'
    WHERE similarity(code, upper(p_code)) > 0.8 AND status != 'inactive';
END;
$$ LANGUAGE plpgsql;