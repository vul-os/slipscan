# Document Processing Script

This Python script automatically processes financial documents (invoices, receipts, statements) using a vision language model, downloads them from Backblaze B2 storage, and saves the extracted data to a Supabase database.

## Features

- ✅ GPU-optimized vision language model (Qwen2-VL-2B)
- ✅ Automatic document type detection
- ✅ Generic JSON extraction format
- ✅ Supabase database integration
- ✅ Backblaze B2 file download integration
- ✅ Batch processing of documents
- ✅ Robust error handling and logging
- ✅ Progress tracking and statistics
- ✅ Configurable processing parameters

## Requirements

### Configuration

The script uses a `config.toml` file for configuration. Update this file with your credentials:

```toml
[supabase]
url = "https://your-project.supabase.co"
service_role_key = "your-service-role-key-here"
default_entity_id = "your-default-entity-uuid-here"

[backblaze]
key_id = "your-b2-key-id-here"
application_key = "your-b2-application-key-here"
bucket_name = "your-bucket-name-here"
bucket_id = "your-bucket-id-here"
base_url = "https://api.backblazeb2.com"

[processing]
batch_size = 10
max_new_tokens = 1024
min_pixels = 3584
max_pixels = 602112
gpu_memory_limit = "4.0GiB"

[logging]
level = "INFO"
format = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
```

### Python Dependencies

Install the required packages:

```bash
pip install -r requirements.txt
```

### Hardware Requirements

- CUDA-compatible GPU with at least 4GB VRAM
- Python 3.8+ 
- Minimum 8GB system RAM

## Usage

1. **Configure the application:**
   ```bash
   # Update config.toml with your credentials
   cp config.toml config.toml.backup
   # Edit config.toml with your Supabase and Backblaze credentials
   ```

2. **Test the connection:**
   ```bash
   python test_connection.py
   ```

3. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

4. **Run the script:**
   ```bash
   python main.py
   ```

The script will:
- Load the vision language model onto GPU
- Connect to Supabase database
- Authenticate with Backblaze B2
- Fetch unprocessed documents from the database
- Download each document from B2 storage
- Process each document to extract structured data
- Save the results to appropriate database tables
- Display progress and statistics

## Document Processing Workflow

### 1. Document Fetching
- Queries `documents` table for records with `processing_status = 'pending'`
- Processes up to `batch_size` documents per run (configurable)

### 2. File Download
- Downloads document files from Backblaze B2 storage
- Creates temporary local copies for processing
- Automatically cleans up temporary files

### 3. Vision Processing
- Uses Qwen2-VL-2B vision-language model
- Extracts structured data using generic JSON prompt
- Handles various document types (invoices, receipts, statements)

### 4. Data Storage
- Saves extracted data to appropriate database tables:
  - **Invoices** → `invoices` table + `invoice_items` table
  - **Receipts** → `receipts` table + `receipt_items` table  
  - **Statements** → `statements` table + `statement_transactions` table
- Updates document processing status

### Generic JSON Schema
The model extracts data in this universal format:

```json
{
  "document_type": "invoice|receipt|statement|other",
  "vendor_name": "string or null",
  "vendor_address": "string or null",
  "customer_name": "string or null", 
  "customer_address": "string or null",
  "document_number": "string or null",
  "transaction_id": "string or null",
  "date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null",
  "subtotal": "decimal number or null",
  "tax_amount": "decimal number or null", 
  "total_amount": "decimal number or null",
  "currency": "string or null",
  "payment_method": "string or null",
  "payment_terms": "string or null",
  "account_number": "string or null",
  "period_start": "YYYY-MM-DD or null",
  "period_end": "YYYY-MM-DD or null",
  "line_items": [
    {
      "description": "string",
      "quantity": "decimal number or null",
      "unit_price": "decimal number or null", 
      "total_price": "decimal number"
    }
  ],
  "notes": "string or null",
  "confidence_score": "decimal between 0 and 1"
}
```

## Error Handling

- Documents that fail processing are marked with `processing_status = 'failed'`
- Error messages are logged and saved to the database
- The script continues processing remaining documents even if some fail
- GPU memory is automatically managed and cleaned up
- Temporary files are automatically cleaned up
- B2 download failures are properly handled and logged

## Performance Configuration

### GPU Settings
- `gpu_memory_limit`: Maximum GPU memory allocation (default: "4.0GiB")
- Automatic GPU selection based on available memory

### Processing Settings
- `batch_size`: Number of documents to process per run (default: 10)
- `max_new_tokens`: Maximum tokens for model generation (default: 1024)
- `min_pixels`/`max_pixels`: Image resolution settings for memory optimization

### Logging Settings
- `level`: Logging level (DEBUG, INFO, WARNING, ERROR)
- `format`: Log message format

## Troubleshooting

### Common Issues

1. **Configuration Errors:**
   - Run `python test_connection.py` to validate setup
   - Ensure all credentials are properly set in `config.toml`

2. **CUDA Out of Memory:**
   - Reduce `gpu_memory_limit` in config.toml
   - Reduce `batch_size` to process fewer documents at once
   - Ensure no other GPU processes are running

3. **Supabase Connection Error:**
   - Verify your `config.toml` has correct credentials
   - Check that your service role key has appropriate permissions

4. **Backblaze B2 Errors:**
   - Verify B2 credentials in `config.toml`
   - Check that the bucket exists and keys have download permissions
   - Ensure document file paths in database match B2 storage structure

5. **Model Loading Issues:**
   - Ensure you have at least 4GB free GPU memory
   - Check internet connection for model download on first run

### Debug Mode

Enable debug logging in `config.toml`:

```toml
[logging]
level = "DEBUG"
```

### Environment Variable Override

You can override config.toml values with environment variables:

```bash
export SUPABASE_URL="https://your-project.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="your-key"
export DEFAULT_ENTITY_ID="your-entity-id"
export B2_KEY_ID="your-b2-key-id"
export B2_APPLICATION_KEY="your-b2-app-key"
export B2_BUCKET_NAME="your-bucket-name"
export B2_BUCKET_ID="your-bucket-id"
```

## Database Schema

The script expects the following tables to exist:
- `documents` - Main document metadata
- `invoices` - Invoice-specific data
- `receipts` - Receipt-specific data  
- `statements` - Statement-specific data
- `invoice_items` - Invoice line items
- `receipt_items` - Receipt line items
- `statement_transactions` - Statement transactions

Refer to `sql/create_tables.sql` for the complete schema.

## File Structure

```
backend/
├── main.py                 # Main processing script
├── test_connection.py      # Connection test utility
├── config.toml            # Configuration file
├── requirements.txt       # Python dependencies
├── README.md             # This file
└── temp_downloads/       # Temporary directory (auto-created)
``` 