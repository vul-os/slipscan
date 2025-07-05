import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Deno types
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

// Types based on Maileroo webhook documentation
interface EmailEvent {
  _id: string
  message_id: string
  domain: string
  envelope_sender: string
  recipients: string[]
  headers: Record<string, string[]>
  body: EmailBody
  attachments: DownloadableAttachment[]
  spf_result: string
  dkim_result: boolean
  is_dmarc_aligned: boolean
  is_spam: boolean
  deletion_url: string
  validation_url: string
  processed_at: number
}

interface DownloadableAttachment {
  filename: string
  content_id: string
  content_type: string
  url: string
  size: number
}

interface EmailBody {
  plaintext: string
  stripped_plaintext: string
  html: string
  stripped_html: string
  other_parts: OtherPart[]
  raw_mime: RawMime
}

interface OtherPart {
  content_type: string
  contents: string
}

interface RawMime {
  url: string
  size: number
}

// Backblaze B2 configuration
const B2_CONFIG = {
  keyId: Deno.env.get('B2_KEY_ID'),
  applicationKey: Deno.env.get('B2_APPLICATION_KEY'),
  bucketName: Deno.env.get('B2_BUCKET_NAME'),
  baseUrl: 'https://api.backblazeb2.com'
}

// Supabase configuration
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

// B2 API client
class BackblazeB2 {
  private authToken: string | null = null
  private apiUrl: string | null = null
  private downloadUrl: string | null = null

  async authenticate(): Promise<void> {
    const credentials = btoa(`${B2_CONFIG.keyId}:${B2_CONFIG.applicationKey}`)
    
    const response = await fetch(`${B2_CONFIG.baseUrl}/b2api/v2/b2_authorize_account`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${credentials}`
      }
    })

    if (!response.ok) {
      throw new Error(`B2 authentication failed: ${response.statusText}`)
    }

    const data = await response.json()
    this.authToken = data.authorizationToken
    this.apiUrl = data.apiUrl
    this.downloadUrl = data.downloadUrl
  }

  async uploadFile(fileName: string, fileContent: Uint8Array, contentType: string): Promise<string> {
    if (!this.authToken || !this.apiUrl) {
      await this.authenticate()
    }

    // Get upload URL
    const uploadUrlResponse = await fetch(`${this.apiUrl}/b2api/v2/b2_get_upload_url`, {
      method: 'POST',
      headers: {
        'Authorization': this.authToken!,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bucketId: B2_CONFIG.bucketName
      })
    })

    if (!uploadUrlResponse.ok) {
      throw new Error(`Failed to get upload URL: ${uploadUrlResponse.statusText}`)
    }

    const uploadUrlData = await uploadUrlResponse.json()
    
    // Upload file
    const uploadResponse = await fetch(uploadUrlData.uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': uploadUrlData.authorizationToken,
        'X-Bz-File-Name': fileName,
        'Content-Type': contentType,
        'X-Bz-Content-Sha1': 'unverified'
      },
      body: fileContent
    })

    if (!uploadResponse.ok) {
      throw new Error(`File upload failed: ${uploadResponse.statusText}`)
    }

    const uploadData = await uploadResponse.json()
    return `${this.downloadUrl}/file/${B2_CONFIG.bucketName}/${fileName}`
  }
}

// Validate webhook authenticity
async function validateWebhook(validationUrl: string): Promise<boolean> {
  try {
    const response = await fetch(validationUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })
    
    if (response.ok) {
      const data = await response.json()
      return data.success === true
    }
    
    return false
  } catch (error) {
    console.error('Webhook validation error:', error)
    return false
  }
}

// Save email to Supabase
async function saveEmailToSupabase(emailEvent: EmailEvent, entityId: string): Promise<string> {
  const { data, error } = await supabase
    .from('emails')
    .insert({
      entity_id: entityId,
      from_address: emailEvent.envelope_sender,
      to_addresses: emailEvent.recipients,
      cc_addresses: emailEvent.headers['cc'] || [],
      bcc_addresses: emailEvent.headers['bcc'] || [],
      subject: emailEvent.headers['subject']?.[0] || '',
      received_at: new Date(emailEvent.processed_at * 1000).toISOString(),
      body_text: emailEvent.body.plaintext,
      body_html: emailEvent.body.html,
      headers: emailEvent.headers,
      processing_status: 'processing',
      total_attachments: emailEvent.attachments.length
    })
    .select('id')
    .single()

  if (error) {
    console.error('Error saving email to Supabase:', error)
    throw new Error(`Failed to save email: ${error.message}`)
  }

  return data.id
}

// Create document in Supabase
async function createDocument(
  entityId: string,
  emailId: string,
  fileName: string,
  filePath: string,
  fileSize: number,
  mimeType: string,
  sourceType: 'email',
  attachmentFilename?: string,
  attachmentContentId?: string
): Promise<string> {
  const { data, error } = await supabase
    .from('documents')
    .insert({
      entity_id: entityId,
      document_type: 'email', // We'll classify later
      file_path: filePath,
      file_name: fileName,
      file_size: fileSize,
      mime_type: mimeType,
      processing_status: 'pending',
      source_type: sourceType,
      source_email_id: emailId,
      source_attachment_filename: attachmentFilename,
      source_attachment_content_id: attachmentContentId
    })
    .select('id')
    .single()

  if (error) {
    console.error('Error creating document:', error)
    throw new Error(`Failed to create document: ${error.message}`)
  }

  return data.id
}

// Log email processing
async function logEmailProcessing(
  emailId: string,
  processingType: 'email_body' | 'attachment',
  status: 'processing' | 'completed' | 'failed' | 'skipped',
  attachmentFilename?: string,
  attachmentContentType?: string,
  attachmentContentId?: string,
  attachmentSize?: number,
  downloadUrl?: string,
  documentId?: string,
  errorMessage?: string,
  skipReason?: string
): Promise<void> {
  const { error } = await supabase
    .from('email_processing_log')
    .insert({
      email_id: emailId,
      processing_type: processingType,
      attachment_filename: attachmentFilename,
      attachment_content_type: attachmentContentType,
      attachment_content_id: attachmentContentId,
      attachment_size: attachmentSize,
      download_url: downloadUrl,
      processing_status: status,
      processed_at: status === 'completed' ? new Date().toISOString() : null,
      document_id: documentId,
      error_message: errorMessage,
      skip_reason: skipReason
    })

  if (error) {
    console.error('Error logging email processing:', error)
  }
}

// Process email body as document
async function processEmailBody(emailEvent: EmailEvent, entityId: string, emailId: string, b2Client: BackblazeB2): Promise<void> {
  try {
    await logEmailProcessing(emailId, 'email_body', 'processing', undefined, 'text/html', undefined, emailEvent.body.html?.length || 0)

    if (!emailEvent.body.html || emailEvent.body.html.trim().length === 0) {
      await logEmailProcessing(emailId, 'email_body', 'skipped', undefined, 'text/html', undefined, 0, undefined, undefined, undefined, 'empty_body')
      return
    }

    // Create filename for email body
    const timestamp = new Date(emailEvent.processed_at * 1000).toISOString().replace(/[:.]/g, '-')
    const fileName = `emails/${entityId}/${emailId}/email-body-${timestamp}.html`

    // Upload email body to Backblaze
    const htmlContent = new TextEncoder().encode(emailEvent.body.html)
    const filePath = await b2Client.uploadFile(fileName, htmlContent, 'text/html')

    // Create document record
    const documentId = await createDocument(
      entityId,
      emailId,
      `email-body-${timestamp}.html`,
      filePath,
      htmlContent.length,
      'text/html',
      'email'
    )

    await logEmailProcessing(emailId, 'email_body', 'completed', undefined, 'text/html', undefined, htmlContent.length, undefined, documentId)
    
    console.log(`✅ Email body processed successfully: ${documentId}`)
  } catch (error) {
    console.error('❌ Error processing email body:', error)
    await logEmailProcessing(emailId, 'email_body', 'failed', undefined, 'text/html', undefined, 0, undefined, undefined, error.message)
  }
}

// Process attachments
async function processAttachments(emailEvent: EmailEvent, entityId: string, emailId: string, b2Client: BackblazeB2): Promise<void> {
  if (!emailEvent.attachments || emailEvent.attachments.length === 0) {
    console.log('📎 No attachments found')
    return
  }

  console.log(`📎 Processing ${emailEvent.attachments.length} attachment(s):`)
  
  for (const attachment of emailEvent.attachments) {
    try {
      await logEmailProcessing(
        emailId,
        'attachment',
        'processing',
        attachment.filename,
        attachment.content_type,
        attachment.content_id,
        attachment.size,
        attachment.url
      )

      console.log(`  - Processing: ${attachment.filename}`)

      // Skip unsupported files
      if (attachment.content_type.startsWith('image/') && attachment.filename.match(/\.(gif|png|jpg|jpeg)$/i)) {
        await logEmailProcessing(
          emailId,
          'attachment',
          'skipped',
          attachment.filename,
          attachment.content_type,
          attachment.content_id,
          attachment.size,
          attachment.url,
          undefined,
          undefined,
          'signature_image'
        )
        console.log(`  - Skipped (likely signature image): ${attachment.filename}`)
        continue
      }

      // Download attachment from Maileroo
      const attachmentResponse = await fetch(attachment.url)
      if (!attachmentResponse.ok) {
        throw new Error(`Failed to download attachment: ${attachmentResponse.statusText}`)
      }

      const attachmentData = new Uint8Array(await attachmentResponse.arrayBuffer())
      
      // Create safe filename for B2
      const timestamp = new Date(emailEvent.processed_at * 1000).toISOString().replace(/[:.]/g, '-')
      const safeFilename = attachment.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
      const fileName = `emails/${entityId}/${emailId}/attachments/${timestamp}-${safeFilename}`

      // Upload to Backblaze
      const filePath = await b2Client.uploadFile(fileName, attachmentData, attachment.content_type)

      // Create document record
      const documentId = await createDocument(
        entityId,
        emailId,
        attachment.filename,
        filePath,
        attachment.size,
        attachment.content_type,
        'email',
        attachment.filename,
        attachment.content_id
      )

      await logEmailProcessing(
        emailId,
        'attachment',
        'completed',
        attachment.filename,
        attachment.content_type,
        attachment.content_id,
        attachment.size,
        attachment.url,
        documentId
      )

      console.log(`  - ✅ Processed: ${attachment.filename} -> ${documentId}`)
      
    } catch (error) {
      console.error(`  - ❌ Failed to process ${attachment.filename}:`, error)
      await logEmailProcessing(
        emailId,
        'attachment',
        'failed',
        attachment.filename,
        attachment.content_type,
        attachment.content_id,
        attachment.size,
        attachment.url,
        undefined,
        error.message
      )
    }
  }
}

// Update email processing status
async function updateEmailProcessingStatus(emailId: string, status: 'completed' | 'failed', errorMessage?: string): Promise<void> {
  const { error } = await supabase
    .from('emails')
    .update({
      processing_status: status,
      processed_at: new Date().toISOString(),
      error_message: errorMessage
    })
    .eq('id', emailId)

  if (error) {
    console.error('Error updating email processing status:', error)
  }
}

// Main webhook handler
serve(async (req: Request) => {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    // Parse the webhook payload
    const emailEvent: EmailEvent = await req.json()
    
    console.log('🔍 Received email webhook:')
    console.log('═'.repeat(50))
    
    // Validate webhook authenticity
    console.log('🔐 Validating webhook...')
    const isValid = await validateWebhook(emailEvent.validation_url)
    
    if (!isValid) {
      console.log('❌ Webhook validation failed')
      return new Response('Webhook validation failed', { status: 400 })
    }
    
    console.log('✅ Webhook validation successful')
    
    // TODO: Determine entity_id from email domain/recipient
    // For now, using a placeholder - you'll need to implement entity resolution
    const entityId = Deno.env.get('DEFAULT_ENTITY_ID')
    if (!entityId) {
      throw new Error('DEFAULT_ENTITY_ID environment variable not set')
    }

    // Initialize B2 client
    const b2Client = new BackblazeB2()

    // Save email to Supabase
    console.log('💾 Saving email to Supabase...')
    const emailId = await saveEmailToSupabase(emailEvent, entityId)
    console.log(`✅ Email saved with ID: ${emailId}`)

    // Process email body as document
    console.log('📄 Processing email body...')
    await processEmailBody(emailEvent, entityId, emailId, b2Client)

    // Process attachments
    console.log('📎 Processing attachments...')
    await processAttachments(emailEvent, entityId, emailId, b2Client)

    // Update email processing status
    await updateEmailProcessingStatus(emailId, 'completed')

    console.log('✅ Email webhook processed successfully!')
    console.log('═'.repeat(50))
    
    // Return success response
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Email webhook processed successfully',
        email_id: emailId,
        maileroo_id: emailEvent._id 
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }
    )
    
  } catch (error) {
    console.error('❌ Error processing webhook:', error)
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: 'Failed to process webhook',
        details: error.message 
      }),
      {
        headers: { 'Content-Type': 'application/json' },
        status: 500,
      }
    )
  }
})
