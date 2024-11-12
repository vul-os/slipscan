// supabase/functions/env-test/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

async function getAccessToken(): Promise<string> {
  console.log('Getting access token...')
  const tokenEndpoint = 'https://oauth2.googleapis.com/token'
  
  // Get credentials from environment
  const clientId = Deno.env.get('GMAIL_CLIENT_ID')
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET')
  const refreshToken = Deno.env.get('GMAIL_REFRESH_TOKEN')

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing required environment variables')
  }

  console.log('Using client ID:', clientId.substring(0, 20) + '...')
  
  const formData = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formData
  })
  
  const text = await response.text()
  console.log('Token response:', text)
  
  if (!response.ok) {
    throw new Error(`Token error (${response.status}): ${text}`)
  }
  
  const data = JSON.parse(text)
  return data.access_token
}

serve(async (req: Request) => {
  try {
    // Verify environment variables are set
    console.log('Environment check:', {
      hasClientId: !!Deno.env.get('GMAIL_CLIENT_ID'),
      hasClientSecret: !!Deno.env.get('GMAIL_CLIENT_SECRET'),
      hasRefreshToken: !!Deno.env.get('GMAIL_REFRESH_TOKEN'),
      hasProjectId: !!Deno.env.get('GOOGLE_PROJECT_ID')
    })

    // Get fresh access token
    const accessToken = await getAccessToken()
    console.log('Got access token:', accessToken.substring(0, 10))

    // Test Gmail API
    const gmailResponse = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      }
    )

    if (!gmailResponse.ok) {
      throw new Error(`Gmail API error (${gmailResponse.status}): ${await gmailResponse.text()}`)
    }

    const gmailData = await gmailResponse.json()
    console.log('Gmail response:', gmailData)

    // If Gmail works, test Pub/Sub
    const pubsubResponse = await fetch(
      `https://pubsub.googleapis.com/v1/projects/${Deno.env.get('GOOGLE_PROJECT_ID')}/topics`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      }
    )

    const pubsubData = await pubsubResponse.json()

    return new Response(JSON.stringify({
      success: true,
      environmentCheck: {
        hasClientId: !!Deno.env.get('GMAIL_CLIENT_ID'),
        hasClientSecret: !!Deno.env.get('GMAIL_CLIENT_SECRET'),
        hasRefreshToken: !!Deno.env.get('GMAIL_REFRESH_TOKEN'),
        hasProjectId: !!Deno.env.get('GOOGLE_PROJECT_ID')
      },
      token: accessToken.substring(0, 10) + '...',
      gmail: gmailData,
      pubsub: pubsubData
    }, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Test error:', error)
    return new Response(JSON.stringify({ 
      success: false,
      error: error.message,
      stack: error.stack,
      environmentCheck: {
        hasClientId: !!Deno.env.get('GMAIL_CLIENT_ID'),
        hasClientSecret: !!Deno.env.get('GMAIL_CLIENT_SECRET'),
        hasRefreshToken: !!Deno.env.get('GMAIL_REFRESH_TOKEN'),
        hasProjectId: !!Deno.env.get('GOOGLE_PROJECT_ID')
      }
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})