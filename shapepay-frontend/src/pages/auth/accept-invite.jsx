import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../../services/supabaseClient';
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"

const AcceptInvitation = () => {
  const [loading, setLoading] = useState(true);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const { token } = useParams(); // Get the token from the URL
  const navigate = useNavigate();

  useEffect(() => {
    const acceptInvitation = async () => {
      try {
        const { data, error } = await supabase
          .rpc('accept_merchant_invitation', { p_token: token });

        if (error || !data) {
          throw new Error('Failed to accept the invitation. The token may be invalid or expired.');
        }

        setSuccess(true);
      } catch (error) {
        setError(error.message);
      } finally {
        setLoading(false);
      }
    };

    acceptInvitation();
  }, [token]);

  if (loading) {
    return <p>Loading...</p>;
  }

  return (
    <div className="container mx-auto max-w-md mt-10">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Accept Invitation</CardTitle>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {success && (
            <Alert variant="success" className="mb-4">
              <AlertDescription>Your invitation has been successfully accepted!</AlertDescription>
            </Alert>
          )}
          <Button onClick={() => navigate('/signin')} className="w-full mt-4">
            {success ? 'Proceed to Sign In' : 'Go Back'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default AcceptInvitation;
