import { serve } from "https://deno.land/std@0.177.0/http/server.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Deno types
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

// Request/Response types
interface CreateDocumentRequest {
  entity_id: string;
  document_type: string;
  document_subtype?: string;
  document_date?: string;
  total_amount?: number;
  entity_name?: string;
  tags?: string[];
  notes?: string;
  uploaded_by?: string;
}

interface CreateDocumentResponse {
  success: boolean;
  document_id?: string;
  file_path?: string;
  document_hash?: string;
  error?: string;
}

interface GetDocumentResponse {
  success: boolean;
  document?: DocumentInfo;
  signed_url?: string;
  error?: string;
}

interface DocumentInfo {
  id: string;
  entity_id: string;
  created_at: string;
  updated_at: string;
  document_type: string;
  document_subtype?: string;
  file_path: string;
  file_name: string;
  file_size?: number;
  mime_type?: string;
  processing_status: string;
  confidence_score?: number;
  document_date?: string;
  total_amount?: number;
  entity_name?: string;
  tags?: string[];
  notes?: string;
  uploaded_by?: string;
  is_processed: boolean;
  is_matched: boolean;
  source_type: string;
  document_hash?: string;
}

interface DeleteDocumentResponse {
  success: boolean;
  message?: string;
  error?: string;
}

// Backblaze B2 configuration
const B2_CONFIG = {
  keyId: Deno.env.get('B2_KEY_ID'),
  applicationKey: Deno.env.get('B2_APPLICATION_KEY'),
  bucketName: Deno.env.get('B2_BUCKET_NAME'),
  bucketId: Deno.env.get('B2_BUCKET_ID'),
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

  async getUploadUrl(): Promise<{ uploadUrl: string; authorizationToken: string }> {
    if (!this.authToken || !this.apiUrl) {
      await this.authenticate()
    }

    const response = await fetch(`${this.apiUrl}/b2api/v2/b2_get_upload_url`, {
      method: 'POST',
      headers: {
        'Authorization': this.authToken!,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bucketId: B2_CONFIG.bucketId
      })
    })

    if (!response.ok) {
      throw new Error(`Failed to get upload URL: ${response.statusText}`)
    }

    const data = await response.json()
    return {
      uploadUrl: data.uploadUrl,
      authorizationToken: data.authorizationToken
    }
  }

  async getDownloadAuthorization(fileName: string, validDurationInSeconds: number = 3600): Promise<string> {
    if (!this.authToken || !this.apiUrl) {
      await this.authenticate()
    }

    const response = await fetch(`${this.apiUrl}/b2api/v2/b2_get_download_authorization`, {
      method: 'POST',
      headers: {
        'Authorization': this.authToken!,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bucketId: B2_CONFIG.bucketId,
        fileNamePrefix: fileName,
        validDurationInSeconds: validDurationInSeconds
      })
    })

    if (!response.ok) {
      throw new Error(`Failed to get download authorization: ${response.statusText}`)
    }

    const data = await response.json()
    return data.authorizationToken
  }

  async deleteFile(fileName: string, fileId: string): Promise<void> {
    if (!this.authToken || !this.apiUrl) {
      await this.authenticate()
    }

    const response = await fetch(`${this.apiUrl}/b2api/v2/b2_delete_file_version`, {
      method: 'POST',
      headers: {
        'Authorization': this.authToken!,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fileName: fileName,
        fileId: fileId
      })
    })

    if (!response.ok) {
      throw new Error(`Failed to delete file: ${response.statusText}`)
    }
  }

  getSignedUrl(fileName: string, authToken: string): string {
    return `${this.downloadUrl}/file/${B2_CONFIG.bucketName}/${fileName}?Authorization=${authToken}`
  }
}

// Calculate SHA-256 hash of file data
async function calculateFileHash(fileData: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', fileData);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

// Create document with file upload and hash calculation
async function createDocument(
  request: CreateDocumentRequest, 
  fileData: Uint8Array, 
  fileName: string, 
  mimeType: string
): Promise<CreateDocumentResponse> {
  console.log('📝 Creating document:', {
    entity_id: request.entity_id,
    file_name: fileName,
    file_size: fileData.length,
    mime_type: mimeType
  })

  try {
    // Generate file path using entityid/filename structure
    const timestamp = Date.now()
    const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
    const filePath = `${request.entity_id}/${timestamp}-${safeFileName}`

    console.log('🗂️ Generated file path:', filePath)

    // Calculate file hashes
    console.log('🔒 Calculating file hashes...')
    const fileHashSha256 = await calculateFileHash(fileData)
    
    // Calculate SHA1 for B2 upload verification
    const sha1HashBuffer = await crypto.subtle.digest('SHA-1', fileData);
    const sha1HashArray = Array.from(new Uint8Array(sha1HashBuffer));
    const sha1Hash = sha1HashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    console.log('✅ File hashes calculated:', {
      sha256: fileHashSha256.substring(0, 8) + '...',
      sha1: sha1Hash.substring(0, 8) + '...'
    })

    // Upload to Backblaze B2
    console.log('☁️ Uploading to Backblaze B2...')
    const b2Client = new BackblazeB2()
    
    // Get upload URL and token
    const uploadInfo = await b2Client.getUploadUrl()
    console.log('📤 Got B2 upload URL and token')
    
    // Encode filename for B2
    const encodedFileName = encodeURIComponent(filePath)
    
    // Upload file to B2
    const uploadResponse = await fetch(uploadInfo.uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': uploadInfo.authorizationToken,
        'X-Bz-File-Name': encodedFileName,
        'Content-Type': mimeType,
        'Content-Length': fileData.length.toString(),
        'X-Bz-Content-Sha1': sha1Hash
      },
      body: fileData
    })
    
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text()
      console.error('❌ B2 upload error details:', {
        status: uploadResponse.status,
        statusText: uploadResponse.statusText,
        error: errorText
      })
      throw new Error(`B2 upload failed: ${uploadResponse.status} ${uploadResponse.statusText} - ${errorText}`)
    }
    
    const uploadResult = await uploadResponse.json()
    console.log('✅ File uploaded successfully to B2:', {
      fileName: uploadResult.fileName,
      fileId: uploadResult.fileId
    })

    // Create document record in Supabase
    console.log('💾 Creating document record...')
    const { data, error } = await supabase
      .from('documents')
      .insert({
        entity_id: request.entity_id,
        document_type: request.document_type,
        document_subtype: request.document_subtype,
        file_path: filePath,
        file_name: fileName,
        file_size: fileData.length,
        mime_type: mimeType,
        document_date: request.document_date,
        total_amount: request.total_amount,
        entity_name: request.entity_name,
        tags: request.tags,
        notes: request.notes,
        uploaded_by: request.uploaded_by,
        document_hash: fileHashSha256,
        processing_status: 'pending',
        source_type: 'upload'
      })
      .select('id')
      .single()

    if (error) {
      console.error('❌ Failed to create document record:', error)
      throw new Error(`Failed to create document: ${error.message}`)
    }

    console.log('✅ Document created successfully:', data.id)

    return {
      success: true,
      document_id: data.id,
      file_path: filePath,
      document_hash: fileHashSha256
    }
  } catch (error) {
    console.error('❌ Error creating document:', error)
    return {
      success: false,
      error: error.message
    }
  }
}

// Get document
async function getDocument(documentId: string): Promise<GetDocumentResponse> {
  console.log('📄 Getting document:', documentId)

  try {
    // Get document from Supabase
    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .single()

    if (error) {
      console.error('❌ Failed to get document from database:', error)
      throw new Error(`Failed to get document: ${error.message}`)
    }

    if (!data) {
      console.log('❌ Document not found:', documentId)
      return {
        success: false,
        error: 'Document not found'
      }
    }

    console.log('📄 Found document:', {
      id: data.id,
      file_name: data.file_name,
      file_path: data.file_path,
      processing_status: data.processing_status
    })

    // Get signed URL from Backblaze
    const b2Client = new BackblazeB2()
    const fileName = data.file_path
    console.log('☁️ Getting signed URL for file:', fileName)
    
    const authToken = await b2Client.getDownloadAuthorization(fileName)
    const signedUrl = b2Client.getSignedUrl(fileName, authToken)

    console.log('✅ Generated signed URL successfully')

    return {
      success: true,
      document: data as DocumentInfo,
      signed_url: signedUrl
    }
  } catch (error) {
    console.error('❌ Error getting document:', error)
    return {
      success: false,
      error: error.message
    }
  }
}



// Delete document
async function deleteDocument(documentId: string): Promise<DeleteDocumentResponse> {
  console.log('🗑️ Deleting document:', documentId)

  try {
    // Get document info first
    const { data: document, error: getError } = await supabase
      .from('documents')
      .select('file_path, file_name')
      .eq('id', documentId)
      .single()

    if (getError) {
      console.error('❌ Failed to get document for deletion:', getError)
      throw new Error(`Failed to get document: ${getError.message}`)
    }

    if (!document) {
      console.log('❌ Document not found:', documentId)
      return {
        success: false,
        error: 'Document not found'
      }
    }

    console.log('🗂️ Found document to delete:', document.file_path)

    // Delete from Supabase first
    const { error: deleteError } = await supabase
      .from('documents')
      .delete()
      .eq('id', documentId)

    if (deleteError) {
      console.error('❌ Failed to delete from database:', deleteError)
      throw new Error(`Failed to delete document from database: ${deleteError.message}`)
    }

    // TODO: Delete from Backblaze B2
    // Note: You would need the fileId from B2 to delete the file
    // For now, we'll just delete from the database
    console.log(`✅ Document ${documentId} deleted from database. File at ${document.file_path} may still exist in B2.`)

    return {
      success: true,
      message: 'Document deleted successfully'
    }
  } catch (error) {
    console.error('❌ Error deleting document:', error)
    return {
      success: false,
      error: error.message
    }
  }
}

// Main handler
serve(async (req: Request) => {
  // Enable CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS, PUT, PATCH',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-client-info, apikey, x-supabase-auth-token, x-supabase-client',
    'Access-Control-Max-Age': '86400',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const method = req.method
    
    // Extract path after document-manager
    let functionPath = url.pathname
    
    // Remove function name from path
    if (functionPath.startsWith('/document-manager')) {
      functionPath = functionPath.replace('/document-manager', '')
    } else if (functionPath.includes('/document-manager')) {
      functionPath = functionPath.split('/document-manager')[1] || ''
    }
    
    // Clean up leading slash
    functionPath = functionPath.replace(/^\/+/, '')
    const pathParts = functionPath.split('/').filter(p => p)
    
    console.log('🛣️ Route info:', { method, pathname: url.pathname, functionPath, pathParts })

    // Routes
    if (method === 'POST' && pathParts.length === 0) {
      // Create document with file upload: POST /
      console.log('📥 POST / - Creating new document with file upload')
      
      try {
        const contentType = req.headers.get('content-type') || ''
        
        if (contentType.includes('multipart/form-data')) {
          // Handle multipart form data
          const formData = await req.formData()
          const file = formData.get('file') as File
          const metadataJson = formData.get('metadata') as string
          
          if (!file || !metadataJson) {
            return new Response(JSON.stringify({ 
              success: false, 
              error: 'Missing file or metadata' 
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            })
          }
          
          const metadata: CreateDocumentRequest = JSON.parse(metadataJson)
          const fileData = new Uint8Array(await file.arrayBuffer())
          
          const result = await createDocument(metadata, fileData, file.name, file.type)
          
          console.log('📤 POST / - Response:', { success: result.success, error: result.error })
          return new Response(JSON.stringify(result), {
            status: result.success ? 200 : 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        } else {
          // Handle JSON request with base64 file data
          const requestData = await req.json()
          const { file_data, file_name, mime_type, ...metadata } = requestData
          
          if (!file_data || !file_name || !mime_type) {
            return new Response(JSON.stringify({ 
              success: false, 
              error: 'Missing file_data, file_name, or mime_type' 
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            })
          }
          
          // Decode base64 file data
          const fileData = Uint8Array.from(atob(file_data), c => c.charCodeAt(0))
          
          const result = await createDocument(metadata, fileData, file_name, mime_type)
          
          console.log('📤 POST / - Response:', { success: result.success, error: result.error })
          return new Response(JSON.stringify(result), {
            status: result.success ? 200 : 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
      } catch (error) {
        console.error('❌ Error processing file upload:', error)
        return new Response(JSON.stringify({ 
          success: false, 
          error: 'Failed to process file upload: ' + error.message 
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }



    if (method === 'GET' && pathParts.length === 1) {
      // Get document: GET /:documentId
      const documentId = pathParts[0]
      console.log('📥 GET /:documentId - Getting document:', documentId)
      const result = await getDocument(documentId)
      
      console.log('📤 GET /:documentId - Response:', { success: result.success, error: result.error })
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (method === 'DELETE' && pathParts.length === 1) {
      // Delete document: DELETE /:documentId
      const documentId = pathParts[0]
      console.log('📥 DELETE /:documentId - Deleting document:', documentId)
      const result = await deleteDocument(documentId)
      
      console.log('📤 DELETE /:documentId - Response:', { success: result.success, error: result.error })
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Route not found
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Route not found' 
    }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Error processing request:', error)
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Internal server error',
      details: error.message 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
