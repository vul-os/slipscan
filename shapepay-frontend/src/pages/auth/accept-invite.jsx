import React, { useState, useEffect, useContext } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { supabase } from '../../services/supabaseClient';
import { AuthContext } from '../../context/use-auth';
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"

const AcceptInvitation = () => {
  const [loading, setLoading] = useState(true);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const { token } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useContext(AuthContext);

  useEffect(() => {
    const acceptInvitation = async () => {
      if (!user) {
        // If user is not logged in, redirect to login page with return URL
        const returnUrl = encodeURIComponent(`/accept-invitation/${token}`);
        navigate(`/signin?returnUrl=${returnUrl}`);
        return;
      }

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

    // Check if we're returning from login
    const searchParams = new URLSearchParams(location.search);
    const isReturning = searchParams.get('returning') === 'true';

    if (isReturning || user) {
      acceptInvitation();
    } else {
      setLoading(false);
    }
  }, [token, user, navigate, location.search]);

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
          <Button onClick={() => navigate('/dashboard')} className="w-full mt-4">
            {success ? 'Go to Dashboard' : 'Go Back'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default AcceptInvitation;