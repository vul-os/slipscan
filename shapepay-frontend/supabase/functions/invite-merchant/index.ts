import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE, PUT',
};

console.log(`Function "browser-with-cors" up and running!`);

const RESEND_API_KEY = "***REMOVED***";

Deno.serve(async (req) => {
  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    {
      global: {
        headers: { Authorization: req.headers.get('Authorization')! },
      },
    }
  );

  try {
    const { inviterEmail, inviteeEmail, merchantId, roleName } = await req.json();

    console.log(`Inviting user: ${inviteeEmail} to merchant: ${merchantId} with role: ${roleName}`);

    // Call the Supabase RPC function
    const { data: userResponse, error: userError } = await supabaseClient.rpc('get_or_invite_user', {
      p_merchant_id: merchantId,
      p_email: inviteeEmail,
      p_role_name: roleName,
    });

    if (userError) {
      console.error('Supabase RPC error:', userError);
      return new Response(JSON.stringify({ 
        error: 'Error processing user invitation',
        details: userError.message,
        hint: userError.hint,
        code: userError.code
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!userResponse || userResponse.length === 0) {
      console.error('Unexpected response from Supabase RPC:', userResponse);
      return new Response(JSON.stringify({ 
        error: 'Unexpected response from server',
        details: 'The server returned an empty response'
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { user_id, is_new, invitation_token } = userResponse[0];

    console.log(`User response: user_id=${user_id}, is_new=${is_new}, invitation_token=${invitation_token}`);

    // Send email regardless of whether the user is new or existing
    const inviteUrl = is_new
      ? `https://app.shapepay.co.za/accept-invite/${invitation_token}`
      : `http://app.shapepay.co.za/login`; // Assuming you have a login page

    const emailContent = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${is_new ? 'Invitation to ShapePay' : 'Welcome to ShapePay'}</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background-color: #f9f9f9;
            border-radius: 5px;
            padding: 30px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
          }
          h1 {
            color: #2c3e50;
            margin-bottom: 20px;
          }
          .button {
            display: inline-block;
            background-color: #3498db;
            color: white;
            padding: 12px 24px;
            text-decoration: none;
            border-radius: 5px;
            font-weight: bold;
            margin-top: 20px;
          }
          .button:hover {
            background-color: #2980b9;
          }
          .footer {
            margin-top: 30px;
            font-size: 0.9em;
            color: #7f8c8d;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>${is_new ? 'You\'ve been invited to join ShapePay!' : 'Welcome to ShapePay!'}</h1>
          <p>Hello,</p>
          <p>${is_new 
              ? `You've been invited by ${inviterEmail} to join as a ${roleName} for a merchant on ShapePay.` 
              : `You've been added by ${inviterEmail} as a ${roleName} for a merchant on ShapePay.`
            }</p>
          <p>${is_new
              ? 'To get started, click the button below to accept your invitation:'
              : 'To access your account, click the button below to log in:'
            }</p>
          <a href="${inviteUrl}" class="button">${is_new ? 'Accept Invitation' : 'Log In'}</a>
          ${is_new ? '<p>This invitation expires in 7 days.</p>' : ''}
          <p>If you have any questions, please don't hesitate to contact our support team.</p>
          <p>Best regards,<br>The ShapePay Team</p>
        </div>
        <div class="footer">
          <p>This email was sent by ShapePay. Please do not reply to this email.</p>
        </div>
      </body>
      </html>
    `;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'invitations@updates.shapepay.co.za',
        to: inviteeEmail,
        subject: is_new ? 'Invitation to join ShapePay' : 'Welcome to ShapePay',
        html: emailContent,
      }),
    });

    const emailData = await res.json();

    console.log('Email sent successfully:', emailData);

    return new Response(JSON.stringify({ 
      message: is_new ? 'Invitation sent' : 'User added to merchant and role assigned',
      emailData 
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Unexpected error:', error);
    return new Response(JSON.stringify({ 
      error: 'An unexpected error occurred',
      details: error.message,
      stack: error.stack
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});