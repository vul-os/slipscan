import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from '@/context/auth-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Mail, Lock, AlertCircle, Brain, Globe, FileText } from 'lucide-react';
import Logo from '@/components/ui/logo';

const SignInPage = () => {
  const navigate = useNavigate();
  const { signIn, signInWithGoogle } = useAuth();
  const [errors, setErrors] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });

  const validateForm = () => {
    const newErrors = {};
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.email)) {
      newErrors.email = 'Please enter a valid email address';
    }
    
    if (!formData.password) {
      newErrors.password = 'Password is required';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
    if (errors[name]) {
      setErrors(prev => ({
        ...prev,
        [name]: undefined
      }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (validateForm()) {
      setIsLoading(true);
      try {
        await signIn(formData.email, formData.password);
        // Navigation will be handled by auth context
      } catch (error) {
        setErrors(prev => ({
          ...prev,
          submit: error.message
        }));
      } finally {
        setIsLoading(false);
      }
    }
  };

  const handleGoogleSignIn = async () => {
    try {
      setIsLoading(true);
      await signInWithGoogle();
    } catch (error) {
      setErrors(prev => ({
        ...prev,
        submit: error.message
      }));
      setIsLoading(false);
    }
  };

  return (
    <div className="h-screen flex flex-col justify-center bg-gradient-to-br from-gray-50/30 via-white to-purple-50/10 px-4 py-4 relative overflow-hidden">
      {/* Background decorations */}
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiM4YjVjZjYiIGZpbGwtb3BhY2l0eT0iMC4wMyI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iNCIvPjwvZz48L2c+PC9zdmc+')] opacity-40"></div>
        <div className="absolute top-20 right-10 w-20 h-20 bg-gradient-to-br from-purple-500 to-blue-500 rounded-full opacity-10 animate-pulse"></div>
        <div className="absolute bottom-32 left-10 w-32 h-32 bg-purple-500/5 rounded-full"></div>
        <div className="absolute top-1/3 right-1/4 w-16 h-16 bg-blue-500/5 rounded-full"></div>
      </div>
      
      <div className="w-full max-w-sm mx-auto space-y-6 relative z-10">
        {/* SlipScan Logo */}
        <div className="flex justify-center mb-4">
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
          <CardHeader className="space-y-2 pb-6 text-center px-6 pt-6">
            <CardTitle className="text-2xl font-bold tracking-tight text-gray-900">
              Welcome Back
            </CardTitle>
            <CardDescription className="text-gray-600">
              Sign in to access your AI-powered financial insights
            </CardDescription>
          </CardHeader>
          <CardContent className="px-6 pb-6">
            {errors.submit && (
              <Alert variant="destructive" className="mb-6 border-l-4 border-red-500 bg-red-50/80">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription className="text-sm">{errors.submit}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-6">
              <Button 
                variant="outline" 
                className="w-full flex items-center justify-center gap-3 h-12 border-2 border-gray-300 bg-white hover:bg-gray-50 transition-all duration-200 shadow-sm text-base font-medium rounded-xl"
                onClick={handleGoogleSignIn}
                disabled={isLoading}
              >
                <div className="w-5 h-5 bg-white rounded flex items-center justify-center">
                  <img 
                    src="/google.png" 
                    alt="Google" 
                    className="w-5 h-5"
                  />
                </div>
                <span>Continue with Google</span>
              </Button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-gray-300" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-4 bg-white text-gray-500 font-medium">OR</span>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-sm font-semibold text-gray-700">Email address</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-3.5 h-5 w-5 text-gray-400" />
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      className={`pl-11 h-12 bg-white border-2 border-gray-300 focus:border-purple-500 focus:ring-2 focus:ring-purple-200 transition-all duration-200 text-base rounded-xl ${errors.email ? "border-red-400" : ""}`}
                      value={formData.email}
                      onChange={handleInputChange}
                      required
                      disabled={isLoading}
                      placeholder="your.email@example.com"
                    />
                  </div>
                  {errors.email && (
                    <p className="text-sm text-red-500">{errors.email}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="password" className="text-sm font-semibold text-gray-700">Password</Label>
                    <Button 
                      variant="link" 
                      type="button"
                      className="text-sm text-purple-600 hover:text-purple-700 p-0 h-auto font-medium"
                      onClick={() => navigate('/forgot-password')}
                      disabled={isLoading}
                    >
                      Forgot password?
                    </Button>
                  </div>
                  <div className="relative">
                    <Lock className="absolute left-3 top-3.5 h-5 w-5 text-gray-400" />
                    <Input
                      id="password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      className={`pl-11 h-12 bg-white border-2 border-gray-300 focus:border-purple-500 focus:ring-2 focus:ring-purple-200 transition-all duration-200 text-base rounded-xl ${errors.password ? "border-red-400" : ""}`}
                      value={formData.password}
                      onChange={handleInputChange}
                      required
                      disabled={isLoading}
                      placeholder="Enter your password"
                    />
                  </div>
                  {errors.password && (
                    <p className="text-sm text-red-500">{errors.password}</p>
                  )}
                </div>

                <Button 
                  type="submit" 
                  className="w-full h-12 bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold shadow-lg hover:shadow-xl transition-all duration-300 text-base rounded-xl"
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <div className="flex items-center space-x-2">
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      <span>Signing in...</span>
                    </div>
                  ) : (
                    <div className="flex items-center space-x-2">
                      <Brain className="w-5 h-5" />
                      <span>Access Dashboard</span>
                    </div>
                  )}
                </Button>
              </form>

              <div className="text-center pt-4">
                <span className="text-sm text-gray-600">Don't have an account?{' '}</span>
                <Button
                  variant="link"
                  type="button"
                  className="text-purple-600 hover:text-purple-700 p-0 h-auto font-semibold text-sm"
                  onClick={() => navigate('/signup')}
                  disabled={isLoading}
                >
                  Create account
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Features preview */}
        <div className="text-center space-y-3">
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

export default SignInPage;