# Email Webhook Function

This Supabase Edge Function processes email webhooks from Maileroo, saves email data to Supabase, and uploads attachments and email bodies to Backblaze B2 storage.

## Features

- ✅ Webhook authentication validation
- ✅ Email metadata storage in Supabase
- ✅ Email body saved as HTML document to Backblaze
- ✅ Attachment processing and upload to Backblaze
- ✅ Document records created for both email bodies and attachments
- ✅ Comprehensive processing logs
- ✅ Error handling and retry logic

## Environment Variables

Set these environment variables in your Supabase project:

```bash
# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Backblaze B2 Configuration
B2_KEY_ID=your-b2-key-id
B2_APPLICATION_KEY=your-b2-application-key
B2_BUCKET_NAME=your-bucket-name

# Entity Configuration
DEFAULT_ENTITY_ID=your-default-entity-uuid
```

## Setup Instructions

1. **Configure Backblaze B2:**
   - Create a B2 bucket for document storage
   - Generate application keys with read/write access
   - Set the environment variables

2. **Configure Supabase:**
   - Set your Supabase URL and service role key
   - Ensure the database schema is deployed (see `sql/create_tables.sql`)

3. **Deploy the function:**
   ```bash
   supabase functions deploy email-webhook-main
   ```

4. **Configure Maileroo webhook:**
   - Set webhook URL to: `https://your-project.supabase.co/functions/v1/email-webhook-main`
   - Enable webhook authentication

## Database Schema

The function expects these tables:
- `emails` - Email metadata storage
- `documents` - Document records for email bodies and attachments
- `email_processing_log` - Processing attempt logs
- `entities` - Entity/organization records

## File Organization

Email files are stored in Backblaze with this structure:
```
emails/
├── {entity_id}/
│   ├── {email_id}/
│   │   ├── email-body-{timestamp}.html
│   │   └── attachments/
│   │       ├── {timestamp}-{filename}
│   │       └── ...
```

## Processing Flow

1. **Webhook received** → Validate authenticity
2. **Save email** → Store metadata in `emails` table
3. **Process email body** → Upload HTML to B2, create document record
4. **Process attachments** → Download from Maileroo, upload to B2, create document records
5. **Log everything** → Track processing in `email_processing_log`
6. **Update status** → Mark email as processed

## Error Handling

- Failed attachments are logged but don't fail the entire process
- Signature images are automatically skipped
- Processing logs track all attempts and outcomes
- Webhook validation failures return 400 status

## Development

The function uses Deno runtime with these imports:
- `https://deno.land/std@0.177.0/http/server.ts` for HTTP server
- `jsr:@supabase/supabase-js@2` for Supabase client
- Built-in `fetch` for HTTP requests

## Testing

Test webhook locally:
```bash
supabase functions serve email-webhook-main
```

Send test webhook:
```bash
curl -X POST http://localhost:54321/functions/v1/email-webhook-main \
  -H "Content-Type: application/json" \
  -d @test-webhook.json
``` 