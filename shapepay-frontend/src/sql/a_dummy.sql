-- Insert dummy data for merchants
INSERT INTO merchants (id, name, email, phone, handle)
VALUES 
  ('11111111-1111-1111-1111-111111111111', 'Acme Corp', 'contact@acmecorp.com', '+27123456789', 'acmecorp'),
  ('22222222-2222-2222-2222-222222222222', 'Beta Industries', 'info@betaindustries.com', '+27987654321', 'betaindustries');

-- Insert dummy data for customers
INSERT INTO customers (id, merchant_id, phone, name, email)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', '+27111111111', 'John Doe', 'john@example.com'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', '+27222222222', 'Jane Smith', 'jane@example.com'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', '+27333333333', 'Bob Johnson', 'bob@example.com'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '22222222-2222-2222-2222-222222222222', '+27444444444', 'Alice Brown', 'alice@example.com'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '22222222-2222-2222-2222-222222222222', '+27555555555', 'Charlie Davis', 'charlie@example.com');
