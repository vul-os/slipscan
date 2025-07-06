-- Emails table - track incoming emails that contain documents
CREATE TABLE emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Email metadata
    from_address VARCHAR(255) NOT NULL,
    to_addresses TEXT[] NOT NULL,
    cc_addresses TEXT[],
    bcc_addresses TEXT[],
    subject TEXT,
    received_at TIMESTAMP WITH TIME ZONE NOT NULL,
    
    -- Email content
    body_text TEXT,
    body_html TEXT,
    
    -- Email headers (as JSON)
    headers JSONB,
    
    -- Processing status
    processing_status VARCHAR(20) DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
    processed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    
    -- Document processing summary
    total_attachments INTEGER DEFAULT 0,
    processed_attachments INTEGER DEFAULT 0,
    failed_attachments INTEGER DEFAULT 0
);


-- Central documents table - file management and metadata
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Document classification
    document_type VARCHAR(50) NOT NULL, -- 'invoice', 'receipt', 'statement'
    document_subtype VARCHAR(50), -- 'business_receipt', 'pos_receipt', 'bank_statement', 'utility_bill'
    
    -- File information
    file_path VARCHAR(500) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_size INTEGER,
    mime_type VARCHAR(100),
    
    -- Processing status
    processing_status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    confidence_score DECIMAL(3,2), -- overall OCR/AI confidence
    error_message TEXT,
    
    -- Basic document info (for quick filtering without joins)
    document_date DATE,
    total_amount DECIMAL(12,2),
    entity_name VARCHAR(255), -- vendor, merchant, or bank name
    
    -- Metadata
    tags TEXT[],
    notes TEXT,
    uploaded_by VARCHAR(255),
    
    -- Matching status
    is_processed BOOLEAN DEFAULT false,
    is_matched BOOLEAN DEFAULT false,
    
    -- Email source tracking
    source_type VARCHAR(20) DEFAULT 'upload' CHECK (source_type IN ('upload', 'email')),
    source_email_id UUID REFERENCES emails(id) ON DELETE SET NULL,
    -- Store original attachment metadata for reference
    source_attachment_filename VARCHAR(255),
    source_attachment_content_id VARCHAR(255)
);

-- Add document hash column for duplicate detection and integrity checking
ALTER TABLE documents ADD COLUMN document_hash VARCHAR(64);

-- Add index on document_hash for performance and duplicate detection
CREATE INDEX idx_documents_hash ON documents(document_hash);

-- Add unique constraint on hash within entity to prevent duplicates
CREATE UNIQUE INDEX idx_documents_entity_hash ON documents(entity_id, document_hash) WHERE document_hash IS NOT NULL;

-- Email processing log - track individual attachment processing attempts
CREATE TABLE email_processing_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- What is being processed
    processing_type VARCHAR(20) NOT NULL CHECK (processing_type IN ('email_body', 'attachment')),
    
    -- Attachment metadata from webhook (NULL for email body)
    attachment_filename VARCHAR(255), -- NULL for email body processing
    attachment_content_type VARCHAR(100), -- 'text/html' or 'text/plain' for email body
    attachment_content_id VARCHAR(255), -- NULL for email body
    attachment_size INTEGER, -- email body size or attachment size
    download_url TEXT, -- NULL for email body (content is in emails table)
    
    -- Processing outcome
    processing_status VARCHAR(20) DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
    processed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    
    -- Link to created document (if processed successfully)
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    
    -- Skip reason (for non-document attachments or email body)
    skip_reason VARCHAR(100) -- 'unsupported_type', 'too_large', 'signature_image', 'empty_body', etc.
);

-- Invoices table - references documents
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Invoice identification
    invoice_number VARCHAR(100) NOT NULL,
    vendor_name VARCHAR(255) NOT NULL,
    vendor_address TEXT,
    vendor_tax_id VARCHAR(50),
    
    -- Customer info
    customer_name VARCHAR(255),
    customer_address TEXT,
    
    -- Dates and amounts
    invoice_date DATE NOT NULL,
    due_date DATE NOT NULL,
    subtotal DECIMAL(12,2) NOT NULL,
    tax_amount DECIMAL(12,2) DEFAULT 0,
    total_amount DECIMAL(12,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Invoice-specific fields
    po_number VARCHAR(100),
    payment_terms VARCHAR(50),
    project_code VARCHAR(50),
    
    -- Status tracking
    status VARCHAR(20) DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid', 'overdue', 'disputed', 'cancelled')),
    date_paid DATE,
    payment_reference VARCHAR(100),
    
    -- Matching support
    matched_payment_id UUID,
    
    -- Processing confidence
    extraction_confidence DECIMAL(3,2),
    
    CONSTRAINT check_total CHECK (total_amount = subtotal + tax_amount),
    UNIQUE(document_id) -- one invoice per document
);

-- Receipts table - references documents  
CREATE TABLE receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Receipt identification
    receipt_number VARCHAR(100),
    transaction_id VARCHAR(100), -- for POS receipts
    merchant_name VARCHAR(255) NOT NULL,
    merchant_address TEXT,
    
    -- Transaction details
    purchase_date DATE NOT NULL,
    purchase_time TIME,
    subtotal DECIMAL(12,2),
    tax_amount DECIMAL(12,2) DEFAULT 0,
    tip_amount DECIMAL(12,2) DEFAULT 0,
    discount_amount DECIMAL(12,2) DEFAULT 0,
    total_amount DECIMAL(12,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    
    -- Payment info
    payment_method VARCHAR(50),
    card_type VARCHAR(50),
    card_last_four VARCHAR(4),
    authorization_code VARCHAR(20),
    
    -- Receipt type and context
    receipt_type VARCHAR(50) DEFAULT 'business', -- 'business', 'pos', 'restaurant', 'gas', 'online'
    
    -- Business expense tracking
    expense_category VARCHAR(100),
    is_reimbursable BOOLEAN DEFAULT false,
    reimbursement_status VARCHAR(20) DEFAULT 'pending',
    employee_name VARCHAR(255),
    
    -- Store/POS details
    store_location VARCHAR(255),
    store_number VARCHAR(50),
    terminal_id VARCHAR(50),
    cashier_id VARCHAR(50),
    
    -- Loyalty/promotions
    customer_id VARCHAR(50),
    loyalty_points_earned INTEGER DEFAULT 0,
    loyalty_points_redeemed INTEGER DEFAULT 0,
    coupon_codes TEXT[],
    
    -- Matching support
    matched_transaction_id UUID,
    
    -- Processing confidence
    extraction_confidence DECIMAL(3,2),
    
    -- Merchant tokenization for matching
    merchant_tokens TEXT[] GENERATED ALWAYS AS (
        string_to_array(
            regexp_replace(
                upper(trim(merchant_name)), 
                '[^A-Z0-9\s]', '', 'g'
            ), 
            ' '
        )
    ) STORED,
    
    UNIQUE(document_id) -- one receipt per document
);

-- Accounts table
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    account_number VARCHAR(100) NOT NULL,
    account_name VARCHAR(255) NOT NULL,
    account_type VARCHAR(50) NOT NULL,
    institution_name VARCHAR(255) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(entity_id, institution_name, account_number)
);

-- Statements table - references documents
CREATE TABLE statements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    account_id UUID NOT NULL REFERENCES accounts(id),
    statement_date DATE NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    
    -- Balances
    beginning_balance DECIMAL(12,2) NOT NULL,
    ending_balance DECIMAL(12,2) NOT NULL,
    
    -- Statement info
    statement_number VARCHAR(100),
    
    -- Processing confidence
    extraction_confidence DECIMAL(3,2),
    
    UNIQUE(document_id), -- one statement per document
    UNIQUE(account_id, statement_date)
);

-- Line items tables (updated naming)
CREATE TABLE invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    description TEXT NOT NULL,
    quantity DECIMAL(10,3) DEFAULT 1,
    unit_price DECIMAL(12,4) NOT NULL,
    line_total DECIMAL(12,2) NOT NULL,
    tax_rate DECIMAL(5,4) DEFAULT 0,
    category VARCHAR(100),
    project_code VARCHAR(50),
    
    UNIQUE(invoice_id, line_number)
);

CREATE TABLE receipt_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    line_number INTEGER,
    
    -- Item identification
    item_name VARCHAR(255) NOT NULL,
    description TEXT,
    sku VARCHAR(100),
    upc VARCHAR(20),
    department VARCHAR(100),
    category VARCHAR(100),
    
    -- Quantity and pricing
    quantity DECIMAL(8,3) DEFAULT 1,
    unit_price DECIMAL(10,2),
    total_price DECIMAL(10,2) NOT NULL,
    
    -- Discounts and tax
    discount_amount DECIMAL(8,2) DEFAULT 0,
    tax_amount DECIMAL(8,2) DEFAULT 0,
    
    UNIQUE(receipt_id, line_number)
);

CREATE TABLE statement_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    statement_id UUID NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
    
    -- Transaction details
    transaction_date DATE NOT NULL,
    posting_date DATE,
    description TEXT NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    running_balance DECIMAL(12,2),
    
    -- Transaction classification
    transaction_type VARCHAR(50),
    reference_number VARCHAR(100),
    check_number VARCHAR(20),
    merchant_name VARCHAR(255),
    merchant_category VARCHAR(100),
    
    -- Matching support
    matched_invoice_id UUID REFERENCES invoices(id),
    matched_receipt_id UUID REFERENCES receipts(id),
    is_matched BOOLEAN DEFAULT false,
    match_confidence DECIMAL(3,2),
    
    -- Merchant tokenization for matching
    merchant_tokens TEXT[] GENERATED ALWAYS AS (
        string_to_array(
            regexp_replace(
                upper(trim(coalesce(merchant_name, description))), 
                '[^A-Z0-9\s]', '', 'g'
            ), 
            ' '
        )
    ) STORED
);

-- Document matching table
CREATE TABLE document_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- What's being matched
    source_type VARCHAR(50) NOT NULL, -- 'statement_transaction', 'invoice', 'receipt'
    source_id UUID NOT NULL,
    target_type VARCHAR(50) NOT NULL,
    target_id UUID NOT NULL,
    
    -- Match quality
    match_type VARCHAR(50) NOT NULL, -- 'exact', 'fuzzy', 'manual', 'rule_based'
    confidence_score DECIMAL(3,2) NOT NULL,
    match_criteria JSONB,
    
    -- Status
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
    reviewed_by VARCHAR(255),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    
    -- Learning feedback
    learning_feedback VARCHAR(20) CHECK (learning_feedback IN ('confirmed', 'rejected', 'pending')),
    
    UNIQUE(source_type, source_id, target_type, target_id)
);

-- Token alias dictionary - the core learning table
CREATE TABLE merchant_token_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token1 VARCHAR(100) NOT NULL,
    token2 VARCHAR(100) NOT NULL,
    confirmation_count INTEGER DEFAULT 0,
    rejection_count INTEGER DEFAULT 0,
    confidence_score DECIMAL(3,2) GENERATED ALWAYS AS (
        CASE 
            WHEN (confirmation_count + rejection_count) = 0 THEN 0
            ELSE confirmation_count::DECIMAL / (confirmation_count + rejection_count)
        END
    ) STORED,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(token1, token2)
);

-- Track which tokens to ignore (learned from data)
CREATE TABLE ignored_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token VARCHAR(100) UNIQUE NOT NULL,
    ignore_confidence DECIMAL(3,2) DEFAULT 0.5,
    learned_from_count INTEGER DEFAULT 0,
    
    -- Common examples: "LLC", "INC", "CORP", "#123", "STORE"
    CONSTRAINT check_confidence CHECK (ignore_confidence BETWEEN 0 AND 1)
);

-- Receipt line item contributions - track shared expenses on receipt items
CREATE TABLE receipt_line_contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- What line item is being contributed to
    receipt_item_id UUID NOT NULL REFERENCES receipt_items(id) ON DELETE CASCADE,
    receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE, -- denormalized for performance
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE, -- owner of the receipt
    
    -- Who is contributing
    contributor_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL, -- NULL if not registered yet
    contributor_email VARCHAR(255) NOT NULL, -- Always store email for tracking
    contributor_name VARCHAR(255), -- Optional display name
    
    -- Contribution details
    contribution_percentage DECIMAL(5,2) NOT NULL CHECK (contribution_percentage > 0 AND contribution_percentage <= 100),
    contribution_amount DECIMAL(10,2) NOT NULL CHECK (contribution_amount > 0),
    
    -- Status tracking
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
    accepted_at TIMESTAMP WITH TIME ZONE,
    rejected_at TIMESTAMP WITH TIME ZONE,
    accepted_by UUID REFERENCES profiles(id),
    rejection_reason TEXT,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Constraints
    UNIQUE(receipt_item_id, contributor_email) -- One contribution per person per item
);

-- Invoice line item contributions - track shared expenses on invoice items
CREATE TABLE invoice_line_contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- What line item is being contributed to
    invoice_item_id UUID NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, -- denormalized for performance
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE, -- owner of the invoice
    
    -- Who is contributing
    contributor_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL, -- NULL if not registered yet
    contributor_email VARCHAR(255) NOT NULL, -- Always store email for tracking
    contributor_name VARCHAR(255), -- Optional display name
    
    -- Contribution details
    contribution_percentage DECIMAL(5,2) NOT NULL CHECK (contribution_percentage > 0 AND contribution_percentage <= 100),
    contribution_amount DECIMAL(10,2) NOT NULL CHECK (contribution_amount > 0),
    
    -- Status tracking
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
    accepted_at TIMESTAMP WITH TIME ZONE,
    rejected_at TIMESTAMP WITH TIME ZONE,
    accepted_by UUID REFERENCES profiles(id),
    rejection_reason TEXT,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Constraints
    UNIQUE(invoice_item_id, contributor_email) -- One contribution per person per item
);

-- Statement transaction contributions - track shared expenses on statement transactions
CREATE TABLE statement_transaction_contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- What transaction is being contributed to
    statement_transaction_id UUID NOT NULL REFERENCES statement_transactions(id) ON DELETE CASCADE,
    statement_id UUID NOT NULL REFERENCES statements(id) ON DELETE CASCADE, -- denormalized for performance
    entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE, -- owner of the statement
    
    -- Who is contributing
    contributor_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL, -- NULL if not registered yet
    contributor_email VARCHAR(255) NOT NULL, -- Always store email for tracking
    contributor_name VARCHAR(255), -- Optional display name
    
    -- Contribution details
    contribution_percentage DECIMAL(5,2) NOT NULL CHECK (contribution_percentage > 0 AND contribution_percentage <= 100),
    contribution_amount DECIMAL(10,2) NOT NULL CHECK (contribution_amount > 0),
    
    -- Status tracking
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
    accepted_at TIMESTAMP WITH TIME ZONE,
    rejected_at TIMESTAMP WITH TIME ZONE,
    accepted_by UUID REFERENCES profiles(id),
    rejection_reason TEXT,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Constraints
    UNIQUE(statement_transaction_id, contributor_email) -- One contribution per person per transaction
);

-- Unified view for all contributions across document types
CREATE VIEW all_line_contributions AS
-- Receipt contributions
SELECT 
    'receipt' as document_type,
    rlc.id as contribution_id,
    rlc.entity_id,
    rlc.contributor_entity_id,
    rlc.contributor_email,
    rlc.contributor_name,
    rlc.contribution_percentage,
    rlc.contribution_amount,
    rlc.status,
    rlc.created_at,
    ri.item_name as line_description,
    ri.total_price as line_total,
    r.merchant_name as vendor_name,
    r.purchase_date as transaction_date
FROM receipt_line_contributions rlc
JOIN receipt_items ri ON rlc.receipt_item_id = ri.id
JOIN receipts r ON rlc.receipt_id = r.id

UNION ALL

-- Invoice contributions
SELECT 
    'invoice' as document_type,
    ilc.id as contribution_id,
    ilc.entity_id,
    ilc.contributor_entity_id,
    ilc.contributor_email,
    ilc.contributor_name,
    ilc.contribution_percentage,
    ilc.contribution_amount,
    ilc.status,
    ilc.created_at,
    ii.description as line_description,
    ii.line_total,
    i.vendor_name,
    i.invoice_date as transaction_date
FROM invoice_line_contributions ilc
JOIN invoice_items ii ON ilc.invoice_item_id = ii.id
JOIN invoices i ON ilc.invoice_id = i.id

UNION ALL

-- Statement transaction contributions
SELECT 
    'statement' as document_type,
    stc.id as contribution_id,
    stc.entity_id,
    stc.contributor_entity_id,
    stc.contributor_email,
    stc.contributor_name,
    stc.contribution_percentage,
    stc.contribution_amount,
    stc.status,
    stc.created_at,
    st.description as line_description,
    ABS(st.amount) as line_total,
    COALESCE(st.merchant_name, 'Unknown') as vendor_name,
    st.transaction_date
FROM statement_transaction_contributions stc
JOIN statement_transactions st ON stc.statement_transaction_id = st.id;


-- Indexes for performance
CREATE INDEX idx_receipt_line_contributions_receipt_item ON receipt_line_contributions(receipt_item_id);
CREATE INDEX idx_receipt_line_contributions_contributor ON receipt_line_contributions(contributor_email);
CREATE INDEX idx_receipt_line_contributions_status ON receipt_line_contributions(status);

CREATE INDEX idx_invoice_line_contributions_invoice_item ON invoice_line_contributions(invoice_item_id);
CREATE INDEX idx_invoice_line_contributions_contributor ON invoice_line_contributions(contributor_email);
CREATE INDEX idx_invoice_line_contributions_status ON invoice_line_contributions(status);

CREATE INDEX idx_statement_transaction_contributions_transaction ON statement_transaction_contributions(statement_transaction_id);
CREATE INDEX idx_statement_transaction_contributions_contributor ON statement_transaction_contributions(contributor_email);
CREATE INDEX idx_statement_transaction_contributions_status ON statement_transaction_contributions(status);

-- Indexes for performance
CREATE INDEX idx_emails_entity_id ON emails(entity_id);
CREATE INDEX idx_emails_from_address ON emails(from_address);
CREATE INDEX idx_emails_processing_status ON emails(processing_status);
CREATE INDEX idx_emails_received_at ON emails(received_at);

CREATE INDEX idx_email_processing_log_email_id ON email_processing_log(email_id);
CREATE INDEX idx_email_processing_log_document_id ON email_processing_log(document_id);
CREATE INDEX idx_email_processing_log_processing_status ON email_processing_log(processing_status);
CREATE INDEX idx_email_processing_log_processing_type ON email_processing_log(processing_type);
CREATE INDEX idx_email_processing_log_content_type ON email_processing_log(attachment_content_type);

CREATE INDEX idx_documents_source_type ON documents(source_type);
CREATE INDEX idx_documents_source_email_id ON documents(source_email_id);
