import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

    const emailContent = is_new
      ? `
        <h1>You've been invited to join as a merchant</h1>
        <p>You've been invited by ${inviterEmail} to join as a ${roleName} for a merchant.</p>
        <p>Click the link below to accept the invitation:</p>
        <a href="${inviteUrl}">Accept Invitation</a>
        <p>This invitation expires in 7 days.</p>
      `
      : `
        <h1>You've been added to a merchant account</h1>
        <p>You've been added by ${inviterEmail} as a ${roleName} for a merchant.</p>
        <p>Click the link below to log in to your account:</p>
        <a href="${inviteUrl}">Log In</a>
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
        subject: is_new ? 'Invitation to join as a merchant' : 'You\'ve been added to a merchant account',
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