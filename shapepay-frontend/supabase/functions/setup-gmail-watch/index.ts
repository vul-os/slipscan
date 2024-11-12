// supabase/functions/setup-gmail-watch/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

async function getAccessToken(): Promise<string> {
  const tokenEndpoint = 'https://oauth2.googleapis.com/token'
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GMAIL_CLIENT_ID')!,
      client_secret: Deno.env.get('GMAIL_CLIENT_SECRET')!,
      refresh_token: Deno.env.get('GMAIL_REFRESH_TOKEN')!,
      grant_type: 'refresh_token',
    }),
  })
  
  if (!response.ok) {
    throw new Error(`Failed to get access token: ${await response.text()}`)
  }
  
  const data = await response.json()
  return data.access_token
}

serve(async (req: Request) => {
  try {
    const accessToken = await getAccessToken()

    // Set up watch on the Gmail inbox
    const response = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/watch',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          labelIds: ['INBOX'],
          topicName: `projects/${Deno.env.get('GOOGLE_PROJECT_ID')}/topics/gmail-notifications`,
          labelFilterAction: 'include'
        })
      }
    )

    if (!response.ok) {
      const errorData = await response.text()
      throw new Error(`Gmail API error: ${errorData}`)
    }

    const data = await response.json()

    return new Response(JSON.stringify({
      success: true,
      historyId: data.historyId,
      expiration: data.expiration
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200
    })
  } catch (error) {
    console.error('Setup error:', error)
    return new Response(JSON.stringify({ 
      success: false,
      error: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})