// supabase/functions/gmail-webhook/index.ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

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
    console.log('Webhook received request')
    const data = await req.json()
    console.log('Request data:', JSON.stringify(data, null, 2))
    
    const accessToken = await getAccessToken()
    console.log('Got access token')

    const decodedData = JSON.parse(atob(data.message.data))
    console.log('Decoded data:', JSON.stringify(decodedData, null, 2))

    // Get history starting from this ID
    const historyResponse = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${decodedData.historyId}`,
      {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      }
    )

    if (!historyResponse.ok) {
      console.error('History response error:', await historyResponse.text())
      throw new Error('Failed to get history')
    }

    const history = await historyResponse.json()
    console.log('History response:', JSON.stringify(history, null, 2))

    if (!history.history?.length) {
      console.log('No new changes found')
      return new Response('No new changes', { status: 200 })
    }

    const messageIds = history.history
      .flatMap(h => h.messages || [])
      .filter(Boolean)
      .map(m => m.id)

    console.log('Found message IDs:', messageIds)

    // Process each message
    const results = await Promise.all(
      messageIds.map(async (messageId) => {
        try {
          console.log(`Processing message ${messageId}`)
          const messageResponse = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
            {
              headers: { 'Authorization': `Bearer ${accessToken}` }
            }
          )

          if (!messageResponse.ok) {
            console.error(`Failed to get message ${messageId}:`, await messageResponse.text())
            return null
          }

          const message = await messageResponse.json()
          console.log(`Message ${messageId} data:`, JSON.stringify(message, null, 2))

          const headers = message.payload.headers
          const from = headers.find((h: any) => h.name === 'From')?.value

          // Only process emails from Absa NotifyMe
          if (from !== 'notifyme@absa.co.za' || from !== 'exolutionza@gmail.com') {
            console.log(`Skipping message from ${from}`)
            return null
          }

          // Get plain text content
          const parts = message.payload.parts || [message.payload]
          const textPart = parts.find((part: any) => part.mimeType === 'text/plain')
          const htmlPart = parts.find((part: any) => part.mimeType === 'text/html')
          
          if (!textPart?.body?.data) {
            console.log('No text content found')
            return null
          }

          // Decode email content
          const content = atob(textPart.body.data.replace(/-/g, '+').replace(/_/g, '/'))
          console.log('Decoded content:', content)

          // Extract transaction details
          const dateMatch = content.match(/Date\s+: (\d{2}\/\d{2}\/\d{4})/)
          const amountMatch = content.match(/Amount\s+: R([\d.]+)/)
          const referenceMatch = content.match(/Reference\s+: ([^\n]+)/)
          const descriptionMatch = content.match(/Transaction: ([^\n]+)/)
          const balanceMatch = content.match(/Available\s+: R([\d.]+)/)

          console.log('Extracted matches:', {
            date: dateMatch?.[1],
            amount: amountMatch?.[1],
            reference: referenceMatch?.[1],
            description: descriptionMatch?.[1],
            balance: balanceMatch?.[1]
          })

          if (!dateMatch || !amountMatch || !referenceMatch || !descriptionMatch || !balanceMatch) {
            console.error('Missing required transaction fields')
            return null
          }

          // Save email and transaction
          const emailData = {
            message_id: messageId,
            thread_id: message.threadId,
            subject: headers.find((h: any) => h.name === 'Subject')?.value,
            from_address: from,
            to_address: [(headers.find((h: any) => h.name === 'To')?.value || '')],
            cc_address: (headers.find((h: any) => h.name === 'Cc')?.value || '').split(',').filter(Boolean),
            received_date: new Date(parseInt(message.internalDate)).toISOString(),
            body_plain: content,
            body_html: htmlPart ? atob(htmlPart.body.data.replace(/-/g, '+').replace(/_/g, '/')) : null
          }

          const { error: emailError } = await supabase
            .from('emails')
            .upsert(emailData, {
              onConflict: 'message_id'
            })

          if (emailError) {
            console.error('Email save error:', emailError)
            throw emailError
          }

          console.log('Saved email:', messageId)

          const transactionData = {
            id: crypto.randomUUID(),
            bank_account_id: Deno.env.get('BANK_ACCOUNT_ID'),
            bank_date: dateMatch[1],
            description: descriptionMatch[1].trim(),
            reference: referenceMatch[1].trim(),
            amount: parseFloat(amountMatch[1]),
            balance: parseFloat(balanceMatch[1]),
            service_fee: 0,
            detected_date: new Date().toISOString(),
            email_id: messageId
          }

          const { error: transactionError } = await supabase
            .from('bank_transactions')
            .upsert(transactionData, {
              onConflict: 'bank_account_id,bank_date,description,reference,amount'
            })

          if (transactionError) {
            console.error('Transaction save error:', transactionError)
            throw transactionError
          }

          console.log('Saved transaction:', transactionData.id)
          return { emailId: messageId, transactionId: transactionData.id }
        } catch (error) {
          console.error(`Error processing message ${messageId}:`, error)
          return null
        }
      })
    )

    const processed = results.filter(Boolean)
    console.log('Processing complete:', processed)

    return new Response(JSON.stringify({
      success: true,
      processed: processed.length,
      items: processed
    }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (error) {
    console.error('Webhook error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500
    })
  }
})