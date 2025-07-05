import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Mail, RefreshCw, Brain, Globe, FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Logo from '@/components/ui/logo';

const VerifyEmailPage = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [isResending, setIsResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    // Get email from localStorage (set during signup)
    const pendingEmail = localStorage.getItem('pendingVerificationEmail');
    if (pendingEmail) {
      setEmail(pendingEmail);
    } else {
      // If no email found, redirect to signup
      navigate('/signup');
    }
  }, [navigate]);

  useEffect(() => {
    let timer;
    if (resendCooldown > 0) {
      timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
    }
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  const handleResendEmail = async () => {
    setIsResending(true);
    setSuccessMessage('');
    
    try {
      // Here you would typically make an API call to resend verification email
      await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate API call
      
      setSuccessMessage('Verification email sent successfully!');
      setResendCooldown(60); // 60 second cooldown
    } catch (error) {
      console.error('Failed to resend verification email:', error);
    } finally {
      setIsResending(false);
    }
  };

  const handleChangeEmail = () => {
    localStorage.removeItem('pendingVerificationEmail');
    localStorage.removeItem('pendingUserData');
    navigate('/signup');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50/30 via-white to-purple-50/10 px-4 py-8 relative overflow-hidden">
      {/* Background decorations */}
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiM4YjVjZjYiIGZpbGwtb3BhY2l0eT0iMC4wMyI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iNCIvPjwvZz48L2c+PC9zdmc+')] opacity-40"></div>
        <div className="absolute top-20 right-10 w-20 h-20 bg-gradient-to-br from-purple-500 to-blue-500 rounded-full opacity-10 animate-pulse"></div>
        <div className="absolute bottom-32 left-10 w-32 h-32 bg-purple-500/5 rounded-full"></div>
        <div className="absolute top-1/3 right-1/4 w-16 h-16 bg-blue-500/5 rounded-full"></div>
      </div>
      
      <div className="w-full max-w-lg space-y-8 relative z-10">
        {/* SlipScan Logo */}
        <div className="flex justify-center mb-6">
          <div className="text-center">
            <div className="flex justify-center items-center mb-4">
              <div className="w-16 h-16 bg-gradient-to-r from-purple-500 to-blue-500 rounded-2xl flex items-center justify-center shadow-lg">
                <Brain className="w-8 h-8 text-white" />
              </div>
            </div>
            <h1 className="text-3xl font-bold tracking-tight mb-2">
              <span className="bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">Slip</span>
              <span className="text-gray-900">Scan</span>
            </h1>
            <p className="text-sm text-gray-600 font-medium">AI-Powered Financial Tracking</p>
          </div>
        </div>

        <Card className="border-2 border-gray-200 shadow-2xl bg-white/95 backdrop-blur-sm rounded-2xl">
          <CardHeader className="space-y-4 pb-6 text-center">
            <div className="mx-auto w-20 h-20 bg-gradient-to-r from-purple-100 to-blue-100 rounded-full flex items-center justify-center">
              <Mail className="w-10 h-10 text-purple-600" />
            </div>
            <CardTitle className="text-2xl font-bold tracking-tight text-gray-900">
              Check Your Email
            </CardTitle>
            <CardDescription className="text-gray-600">
              We've sent a verification link to your email address
            </CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            <div className="space-y-6">
              {successMessage && (
                <Alert className="border-l-4 border-green-500 bg-green-50/80">
                  <Mail className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-sm text-green-800">
                    {successMessage}
                  </AlertDescription>
                </Alert>
              )}

              <div className="rounded-lg bg-purple-50/80 p-4 border border-purple-200/60">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <Mail className="h-5 w-5 text-purple-600" />
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-purple-900">Verification email sent</h3>
                    <div className="mt-2 text-sm text-purple-800">
                      <p>
                        We've sent a verification link to{' '}
                        <span className="font-medium text-purple-900">{email}</span>. Click the link in the email to verify your account.
                      </p>
                      <p className="mt-2">
                        <strong>Can't find the email?</strong> Check your spam folder or try resending it.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <Button 
                  onClick={handleResendEmail}
                  disabled={isResending || resendCooldown > 0}
                  className="w-full h-12 bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold shadow-lg hover:shadow-xl transition-all duration-300 rounded-xl"
                >
                  {isResending ? (
                    <div className="flex items-center space-x-2">
                      <RefreshCw className="w-5 h-5 animate-spin" />
                      <span>Sending...</span>
                    </div>
                  ) : resendCooldown > 0 ? (
                    `Resend in ${resendCooldown}s`
                  ) : (
                    <div className="flex items-center space-x-2">
                      <RefreshCw className="w-5 h-5" />
                      <span>Resend Verification Email</span>
                    </div>
                  )}
                </Button>
                
                <Button
                  variant="outline"
                  onClick={handleChangeEmail}
                  className="w-full h-12 border-2 border-gray-300 hover:bg-gray-50 font-semibold rounded-xl"
                >
                  Use Different Email
                </Button>
                
                <Button
                  variant="ghost"
                  onClick={() => navigate('/signin')}
                  className="w-full h-12 text-gray-600 hover:text-gray-900 hover:bg-gray-50 font-semibold rounded-xl"
                >
                  Back to Sign In
                </Button>
              </div>

              <div className="text-center pt-4">
                <p className="text-sm text-gray-600">
                  After clicking the verification link, you'll be able to access your SlipScan dashboard and start tracking your finances with AI.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Features preview */}
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center space-x-6 text-sm text-gray-600">
            <div className="flex items-center space-x-2">
              <Brain className="w-4 h-4 text-purple-500" />
              <span>AI Processing</span>
            </div>
            <div className="flex items-center space-x-2">
              <Globe className="w-4 h-4 text-purple-500" />
              <span>Any Currency</span>
            </div>
            <div className="flex items-center space-x-2">
              <FileText className="w-4 h-4 text-purple-500" />
              <span>Smart Insights</span>
            </div>
          </div>
          <p className="text-xs text-gray-500">
            © {new Date().getFullYear()} SlipScan - AI-Powered Financial Tracking
          </p>
        </div>
      </div>
    </div>
  );
};

export default VerifyEmailPage; 