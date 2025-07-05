import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Logo from '@/components/ui/logo';
import ScrollToTop from '@/components/ui/scroll-to-top';
import { 
  Mail, 
  FileText, 
  Brain, 
  Globe, 
  Star, 
  CheckCircle, 
  ArrowRight,
  BarChart3,
  Shield,
  Zap,
  MessageSquare,
  Receipt,
  TrendingUp,
  Sparkles,
  Play,
  Phone,
  MapPin,
  Award,
  Lightbulb,
  Target,
  Upload,
  X,
  Loader2,
  AlertCircle,
  DollarSign,
  PieChart,
  Calendar,
  Eye,
  Inbox,
  Search,
  Database,
  CreditCard,
  Banknote,
  Euro,
  Coins
} from 'lucide-react';
import { 
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/services/supabase-client";

// Currency Icons Component
const CurrencyIcon = ({ type = "dollar", className = "w-5 h-5" }) => {
  switch(type) {
    case 'euro':
      return <Euro className={className} />;
    case 'pound':
      return <Banknote className={className} />;
    case 'yen':
      return <Coins className={className} />;
    default:
      return <DollarSign className={className} />;
  }
};

const LandingPage = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  
 
  // Demo modal state
  const [isDemoOpen, setIsDemoOpen] = React.useState(false);
  const [phoneNumber, setPhoneNumber] = React.useState('+27');
  const [isLoading, setIsLoading] = React.useState(false);
  const [demoError, setDemoError] = React.useState('');
  const [demoSuccess, setDemoSuccess] = React.useState(false);

  // Hero animation state
  const [heroStep, setHeroStep] = React.useState(0); // 0: initial, 1: completing, 2: notifications
  const [isAnimating, setIsAnimating] = React.useState(false);

  // Helper function to normalize phone numbers (remove + prefix)
  const normalizePhoneNumber = (phone) => {
    const trimmed = phone.trim();
    return trimmed.startsWith('+') ? trimmed.substring(1) : trimmed;
  };

  // Handle demo submission
  const handleDemoSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setDemoError('');
    
    try {
      // Normalize phone number before processing
      const normalizedPhone = normalizePhoneNumber(phoneNumber);

      // Validate phone number
      if (!normalizedPhone || normalizedPhone.length < 10) {
        setDemoError('Please enter a valid phone number');
        setIsLoading(false);
        return;
      }


      if (error) {
        setDemoError(error.message || 'Failed to send demo message');
        return;
      }

      if (!data.success) {
        setDemoError(data.error || 'Failed to send demo message');
        return;
      }

      setDemoSuccess(true);
      toast({
        title: "Demo sent successfully! 🎉",
        description: `Check your WhatsApp for a demo notification (template message)`,
      });

    } catch (error) {
      setDemoError(error.message || 'Something went wrong. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const resetDemo = () => {
    setDemoSuccess(false);
    setDemoError('');
    setPhoneNumber('+27');
  };

  const openDemo = () => {
    resetDemo();
    setIsDemoOpen(true);
  };

  // Hero animation handler
  const startHeroAnimation = async () => {
    if (isAnimating) return;
    
    setIsAnimating(true);
    setHeroStep(1); // Start completing order
    
    // Step 1: Order completion (2 seconds)
    setTimeout(() => {
      setHeroStep(2); // Show notifications
    }, 2000);
    
    // Step 2: Reset after showing notifications (4 seconds)
    setTimeout(() => {
      setHeroStep(0);
      setIsAnimating(false);
    }, 6000);
  };

  // Smooth scroll function
  const scrollToSection = (sectionId) => {
    const element = document.getElementById(sectionId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const features = [
    {
      icon: <Mail className="w-6 h-6" />,
      title: "Email Your Documents",
      description: "Simply email receipts, statements, and invoices to your unique address. No apps or complex uploads needed.",
      highlight: true
    },
    {
      icon: <Brain className="w-6 h-6" />,
      title: "AI-Powered Extraction", 
      description: "Advanced AI reads every document and extracts line items, dates, amounts, and vendor information automatically.",
      highlight: false
    },
    {
      icon: <Globe className="w-6 h-6" />,
      title: "Any Currency, Any Country",
      description: "Works with documents from anywhere in the world. USD, EUR, GBP, JPY, and 100+ other currencies supported.",
      highlight: false
    },
    {
      icon: <BarChart3 className="w-6 h-6" />,
      title: "Smart Categorization",
      description: "Automatically categorize expenses as business, personal, meals, travel, and more using AI intelligence.",
      highlight: false
    },
    {
      icon: <PieChart className="w-6 h-6" />,
      title: "Instant Insights",
      description: "Get real-time spending insights, monthly summaries, and tax-ready reports generated automatically.",
      highlight: false
    },
    {
      icon: <Shield className="w-6 h-6" />,
      title: "Bank-Level Security",
      description: "Your financial data is encrypted and secure. We never store your documents, only the extracted insights.",
      highlight: false
    }
  ];

  const stats = [
    { number: "50,000+", label: "Documents Processed Monthly", icon: <FileText className="w-6 h-6" /> },
    { number: "150+", label: "Supported Currencies", icon: <Globe className="w-6 h-6" /> },
    { number: "99.9%", label: "Extraction Accuracy", icon: <Brain className="w-6 h-6" /> },
    { number: "<5s", label: "Processing Speed", icon: <Zap className="w-6 h-6" /> }
  ];

  const testimonials = [
    {
      name: "Michael Johnson",
      company: "Tech Startup Founder",
      location: "Austin, TX",
      rating: 5,
      text: "SlipScan saves me 10 hours per month on expense tracking. I just email receipts and get perfect categorization for tax season!",
      avatar: "MJ"
    },
    {
      name: "Sarah Martinez", 
      company: "Freelance Designer",
      location: "Los Angeles, CA",
      rating: 5,
      text: "As a freelancer working internationally, SlipScan handles all my currencies perfectly. No more manual data entry or lost receipts.",
      avatar: "SM"
    },
    {
      name: "David Thompson",
      company: "Small Business Owner",
      location: "London, UK", 
      rating: 5,
      text: "The AI extraction is incredibly accurate. Even handwritten receipts from local shops get processed correctly every time.",
      avatar: "DT"
    }
  ];

  const steps = [
    {
      step: "01",
      title: "Get Your Email Address",
      description: "Sign up and get your unique email address like abc123@docs.slipscan.com. That's it - you're ready to start tracking!",
      icon: <Mail className="w-8 h-8" />
    }
  ];

  const benefits = [
    {
      icon: <Mail className="w-6 h-6" />,
      title: "Email-Based Simplicity",
      description: "No apps to download - just email your documents and get instant results"
    },
    {
      icon: <Brain className="w-6 h-6" />,
      title: "AI-Powered Intelligence",
      description: "Advanced AI extracts every detail with 99.9% accuracy across all document types"
    },
    {
      icon: <BarChart3 className="w-6 h-6" />,
      title: "Real-Time Insights",
      description: "Get instant spending analytics, category breakdowns, and tax-ready reports"
    },
    {
      icon: <Globe className="w-6 h-6" />,
      title: "Global Currency Support",
      description: "Works with any currency from any country - perfect for international finances"
    }
  ];

  return (
    <div className="min-h-screen bg-background overflow-hidden">
      {/* Hero Section */}
      <section id="home" className="relative min-h-[calc(100vh-5rem)] sm:min-h-[calc(100vh-4rem)] flex items-center bg-gradient-to-br from-gray-50/30 via-white to-purple-50/10 pt-8 lg:pt-8">
        {/* Background Pattern */}
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiM4YjVjZjYiIGZpbGwtb3BhY2l0eT0iMC4wMyI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iNCIvPjwvZz48L2c+PC9zdmc+')] opacity-40"></div>
          {/* Floating Elements */}
          <div className="absolute top-20 right-10 w-20 h-20 bg-gradient-to-br from-purple-500 to-blue-500 rounded-full opacity-10 animate-pulse"></div>
          <div className="absolute bottom-32 left-10 w-32 h-32 bg-purple-500/5 rounded-full"></div>
          <div className="absolute top-1/3 right-1/4 w-16 h-16 bg-blue-500/5 rounded-full"></div>
        </div>
        
        <div className="relative z-10 w-full max-w-7xl mx-auto px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-8 lg:gap-16 items-center">
              {/* Left Content */}
                          <div className="space-y-4 sm:space-y-6 lg:space-y-8 text-center lg:text-left">
              <div className="space-y-3 sm:space-y-4 lg:space-y-6">
                <Badge className="inline-flex items-center gap-2 bg-gradient-to-r from-purple-500 to-blue-500 text-white px-4 py-2 text-sm font-semibold rounded-full shadow-lg">
                  <Globe className="w-4 h-4" />
                  Any Currency • Any Country
                </Badge>
                
                <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold leading-tight tracking-tight text-gray-900">
                  AI-Powered Financial Tracking with{' '}
                  <span className="bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">SlipScan</span>
                </h1>
                
                <p className="text-lg sm:text-xl lg:text-2xl text-gray-600 leading-relaxed max-w-2xl lg:max-w-none">
                  Simply email your receipts, statements, and invoices to get instant AI-powered insights. 
                  Track expenses, categorize transactions, and manage your finances effortlessly.
                </p>
              </div>
              
              <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
                <Button 
                  size="lg" 
                  className="bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow-lg hover:shadow-xl transition-all duration-300 group h-14 px-8 text-lg font-semibold rounded-xl"
                  onClick={() => navigate('/signup')}
                >
                  Start Tracking Free
                  <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </Button>
                <Button 
                  size="lg" 
                  variant="outline" 
                  className="border-2 border-purple-500 text-purple-600 hover:bg-purple-500 hover:text-white transition-all duration-300 h-14 px-8 text-lg font-semibold rounded-xl group"
                  onClick={openDemo}
                >
                  <Play className="mr-2 w-5 h-5 group-hover:scale-110 transition-transform" />
                  See Demo
                </Button>
              </div>

              <div className="flex flex-wrap justify-center lg:justify-start gap-4 lg:gap-6 pt-2 lg:pt-4">
                {[
                  { icon: <Mail className="w-5 h-5 text-purple-600" />, text: "Email documents" },
                  { icon: <Brain className="w-5 h-5 text-purple-600" />, text: "AI extraction" },
                  { icon: <Globe className="w-5 h-5 text-purple-600" />, text: "Any currency" }
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-3">
                    {item.icon}
                    <span className="text-sm font-semibold text-gray-700">{item.text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Right Visual - Interactive Animation */}
            <div className="relative">
              {/* Step 0: Email Interface */}
              {heroStep === 0 && (
                <div className="relative z-10 bg-white rounded-3xl shadow-2xl border border-gray-200 overflow-hidden max-w-md mx-auto transform transition-all duration-700">
                  <div className="bg-gradient-to-r from-gray-50 to-gray-100 px-6 py-4 border-b border-gray-200">
                    <div className="flex items-center gap-4">
                      <div className="flex gap-2">
                        <div className="w-3 h-3 rounded-full bg-red-400"></div>
                        <div className="w-3 h-3 rounded-full bg-yellow-400"></div>
                        <div className="w-3 h-3 rounded-full bg-green-400"></div>
                      </div>
                      <h3 className="font-bold text-gray-900 text-lg">Email Receipt</h3>
                      <Badge className="ml-auto bg-purple-100 text-purple-700 text-sm px-3 py-1 rounded-full">
                        <div className="w-2 h-2 bg-purple-500 rounded-full mr-2 animate-pulse"></div>
                        Ready
                      </Badge>
                    </div>
                  </div>
                  
                  <div className="p-6 space-y-4">
                    <div className="p-4 rounded-xl border-2 bg-purple-50 border-purple-200 shadow-lg">
                      <div className="space-y-3">
                        <div className="flex items-center gap-3">
                          <Mail className="w-5 h-5 text-purple-600" />
                          <div className="flex-1">
                            <p className="font-semibold text-gray-900">To: abc123@docs.slipscan.com</p>
                            <p className="text-sm text-gray-600">Subject: Coffee & Lunch Receipt</p>
                          </div>
                        </div>
                        <div className="bg-white p-3 rounded-lg border border-purple-200">
                          <div className="flex items-center gap-2 mb-2">
                            <Receipt className="w-4 h-4 text-purple-600" />
                            <span className="text-sm font-medium text-gray-700">receipt_starbucks.pdf</span>
                          </div>
                          <div className="text-xs text-gray-500">Attached • 247 KB</div>
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-center pt-4">
                      <Button 
                        onClick={startHeroAnimation}
                        disabled={isAnimating}
                        className="bg-gradient-to-r from-purple-500 to-blue-500 text-white px-8 py-3 rounded-xl font-semibold shadow-lg hover:shadow-xl transition-all duration-300 group"
                      >
                        <Upload className="mr-2 w-5 h-5 group-hover:scale-110 transition-transform" />
                        Send & Process
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Step 1: AI Processing */}
              {heroStep === 1 && (
                <div className="relative z-10 bg-white rounded-3xl shadow-2xl border border-gray-200 overflow-hidden max-w-md mx-auto transform transition-all duration-700">
                  <div className="bg-gradient-to-r from-purple-50 to-blue-50 px-6 py-4 border-b border-purple-200">
                    <div className="flex items-center gap-4">
                      <div className="flex gap-2">
                        <div className="w-3 h-3 rounded-full bg-purple-400 animate-pulse"></div>
                        <div className="w-3 h-3 rounded-full bg-blue-400 animate-pulse"></div>
                        <div className="w-3 h-3 rounded-full bg-purple-400 animate-pulse"></div>
                      </div>
                      <h3 className="font-bold text-purple-800 text-lg">AI Processing</h3>
                      <Badge className="ml-auto bg-purple-200 text-purple-800 text-sm px-3 py-1 rounded-full">
                        <Brain className="w-3 h-3 mr-2" />
                        Analyzing
                      </Badge>
                    </div>
                  </div>
                  
                  <div className="p-6 text-center space-y-6">
                    <div className="w-20 h-20 bg-gradient-to-br from-purple-100 to-blue-100 rounded-full flex items-center justify-center mx-auto animate-pulse">
                      <Brain className="w-10 h-10 text-purple-500" />
                    </div>
                    <div>
                      <h3 className="text-xl font-bold text-gray-900 mb-2">Extracting Data...</h3>
                      <p className="text-gray-600">AI is reading your receipt and extracting line items</p>
                    </div>
                    <div className="flex items-center justify-center gap-2">
                      <Loader2 className="w-5 h-5 animate-spin text-purple-500" />
                      <span className="text-sm text-gray-500">Processing document...</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Step 2: Line Items & Insights */}
              {heroStep === 2 && (
                <div className="relative z-10 space-y-4">
                  {/* Extracted Line Items */}
                  <div className="bg-white rounded-2xl shadow-xl border border-gray-200 p-4 animate-in slide-in-from-right-5 duration-700">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-blue-500 rounded-full flex items-center justify-center">
                        <Receipt className="w-5 h-5 text-white" />
                      </div>
                      <div>
                        <div className="font-semibold text-gray-900">Starbucks Downtown</div>
                        <div className="text-xs text-purple-600">March 15, 2024</div>
                      </div>
                      <Badge className="ml-auto bg-purple-100 text-purple-800 text-xs px-2 py-1 rounded-full">
                        Business
                      </Badge>
                    </div>
                    
                    <div className="space-y-2">
                      <div className="flex justify-between items-center p-2 bg-gray-50 rounded-lg">
                        <span className="text-sm text-gray-700">Latte (Large)</span>
                        <span className="text-sm font-semibold text-gray-900">$5.85</span>
                      </div>
                      <div className="flex justify-between items-center p-2 bg-gray-50 rounded-lg">
                        <span className="text-sm text-gray-700">Croissant</span>
                        <span className="text-sm font-semibold text-gray-900">$3.45</span>
                      </div>
                      <div className="flex justify-between items-center p-2 bg-gray-50 rounded-lg">
                        <span className="text-sm text-gray-700">Tax</span>
                        <span className="text-sm font-semibold text-gray-900">$0.74</span>
                      </div>
                      <div className="flex justify-between items-center p-2 bg-purple-50 rounded-lg border border-purple-200">
                        <span className="text-sm font-semibold text-purple-800">Total</span>
                        <span className="text-sm font-bold text-purple-800">$10.04</span>
                      </div>
                    </div>
                  </div>

                  {/* AI Insights */}
                  <div className="bg-gradient-to-r from-purple-50 to-blue-50 rounded-2xl p-6 text-center border-2 border-purple-200 animate-in fade-in duration-1000">
                    <div className="w-16 h-16 bg-gradient-to-br from-purple-500 to-blue-500 rounded-full flex items-center justify-center mx-auto mb-4">
                      <BarChart3 className="w-8 h-8 text-white animate-bounce" />
                    </div>
                    <h3 className="text-lg font-bold text-purple-800 mb-2">Data Extracted!</h3>
                    <p className="text-sm text-purple-700">Receipt processed and categorized as business expense.</p>
                    <div className="flex items-center justify-center gap-4 mt-4 text-sm text-purple-600">
                      <div className="flex items-center gap-1">
                        <Eye className="w-4 h-4" />
                        <span>AI insights</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Database className="w-4 h-4" />
                        <span>Auto-categorized</span>
                      </div>
                    </div>
                  </div>

                  {/* Try Again Button */}
                  <div className="text-center pt-4">
                    <Button 
                      onClick={startHeroAnimation}
                      variant="outline"
                      className="border-purple-500 text-purple-600 hover:bg-purple-500 hover:text-white px-6 py-2 rounded-xl transition-all duration-300"
                    >
                      <Play className="mr-2 w-4 h-4" />
                      See it again
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-8 sm:py-12 lg:py-24 bg-gradient-to-br from-gray-50/50 to-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-8 sm:mb-12 lg:mb-16">
            <Badge className="inline-flex items-center gap-2 bg-purple-100 text-purple-600 px-4 py-2 text-sm font-semibold rounded-full mb-6">
              <Brain className="w-4 h-4" />
              AI-Powered Features
            </Badge>
            <h2 className="text-3xl lg:text-5xl font-bold mb-6 text-gray-900">
              Transform Documents into Insights
            </h2>
            <p className="text-lg lg:text-xl text-gray-600 max-w-3xl mx-auto leading-relaxed">
              SlipScan uses advanced AI to extract every detail from your financial documents, 
              turning receipts and statements into actionable insights instantly.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
            {features.map((feature, i) => (
              <Card key={i} className={`group hover:shadow-2xl transition-all duration-500 hover:-translate-y-2 border-2 ${feature.highlight ? 'ring-2 ring-purple-200 bg-purple-50/50 border-purple-200' : 'border-gray-200 hover:border-purple-300'} rounded-2xl overflow-hidden`}>
                <CardContent className="p-8 text-center">
                  <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform duration-300 ${
                    feature.highlight 
                      ? 'bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow-lg' 
                      : 'bg-gray-100 text-gray-600 group-hover:bg-gradient-to-r group-hover:from-purple-500 group-hover:to-blue-500 group-hover:text-white'
                  }`}>
                    {feature.icon}
                  </div>
                  <h3 className="text-xl lg:text-2xl font-bold mb-4 text-gray-900">{feature.title}</h3>
                  <p className="text-gray-600 leading-relaxed">{feature.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Benefits Section */}
      <section id="benefits" className="py-8 sm:py-12 lg:py-24 bg-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-8 sm:mb-12 lg:mb-16">
            <h2 className="text-3xl lg:text-5xl font-bold mb-6 text-gray-900">
              Financial Tracking Made Effortless
            </h2>
            <p className="text-lg lg:text-xl text-gray-600 max-w-3xl mx-auto">
              No more manual data entry or lost receipts. AI-powered document processing transforms your financial management.
            </p>
          </div>
          
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
            {benefits.map((benefit, i) => (
              <div key={i} className="text-center group">
                <div className="bg-gradient-to-br from-purple-50 to-blue-50 w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform duration-300">
                  <div className="text-purple-500">
                    {benefit.icon}
                  </div>
                </div>
                <h3 className="text-xl font-bold mb-3 text-gray-900">{benefit.title}</h3>
                <p className="text-gray-600">{benefit.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-8 sm:py-12 lg:py-24 bg-gradient-to-br from-gray-50/50 to-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-8 sm:mb-12 lg:mb-16">
            <Badge className="inline-flex items-center gap-2 bg-purple-100 text-purple-600 px-4 py-2 text-sm font-semibold rounded-full mb-6">
              <Mail className="w-4 h-4" />
              Email-Based
            </Badge>
            <h2 className="text-3xl lg:text-5xl font-bold mb-6 text-gray-900">Just 1 Simple Step</h2>
            <p className="text-lg lg:text-xl text-gray-600 max-w-2xl mx-auto">Sign up, get your email address, and start tracking finances</p>
          </div>

          <div className="flex justify-center">
            {steps.map((step, i) => (
              <div key={i} className="text-center group max-w-md">
                <div className="relative mb-8">
                  <div className="w-24 h-24 bg-gradient-to-r from-purple-500 to-blue-500 rounded-3xl flex items-center justify-center text-white mx-auto group-hover:scale-110 transition-transform duration-300 shadow-xl">
                    {step.icon}
                  </div>
                  <div className="absolute -top-3 -right-3 w-12 h-12 bg-gray-900 text-white rounded-2xl flex items-center justify-center text-sm font-bold shadow-lg">
                    {step.step}
                  </div>
                </div>
                <h3 className="text-xl lg:text-2xl font-bold mb-4 text-gray-900">{step.title}</h3>
                <p className="text-gray-600 leading-relaxed text-lg">{step.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section id="testimonials" className="py-8 sm:py-12 lg:py-24 bg-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-8 sm:mb-12 lg:mb-16">
            <Badge className="inline-flex items-center gap-2 bg-purple-100 text-purple-800 px-4 py-2 text-sm font-semibold rounded-full mb-6">
              <Star className="w-4 h-4" />
              Customer Success
            </Badge>
            <h2 className="text-3xl lg:text-5xl font-bold mb-6 text-gray-900">Real Results, Happy Users</h2>
            <p className="text-lg lg:text-xl text-gray-600 max-w-2xl mx-auto">See how professionals transformed their financial tracking</p>
          </div>

          <div className="grid lg:grid-cols-3 gap-6 lg:gap-8">
            {testimonials.map((testimonial, i) => (
              <Card key={i} className="group hover:shadow-2xl transition-all duration-500 hover:-translate-y-2 border-2 border-gray-200 hover:border-purple-300 rounded-2xl overflow-hidden">
                <CardContent className="p-8">
                  <div className="flex items-center mb-6">
                    {[...Array(testimonial.rating)].map((_, j) => (
                      <Star key={j} className="w-5 h-5 fill-purple-400 text-purple-400" />
                    ))}
                  </div>
                  <blockquote className="text-gray-600 mb-6 leading-relaxed text-lg italic">
                    "{testimonial.text}"
                  </blockquote>
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-gradient-to-r from-purple-500 to-blue-500 rounded-2xl flex items-center justify-center text-white font-bold">
                      {testimonial.avatar}
                    </div>
                    <div>
                      <div className="font-bold text-gray-900">{testimonial.name}</div>
                      <div className="text-sm text-gray-600 font-semibold">{testimonial.company}</div>
                      <div className="text-sm text-gray-500 flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {testimonial.location}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Support Section */}
      <section id="support" className="py-8 sm:py-12 lg:py-24 bg-gray-900 text-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-8 sm:mb-12 lg:mb-16">
            <Badge className="inline-flex items-center gap-2 bg-white/10 text-white px-4 py-2 text-sm font-semibold rounded-full mb-6">
              <Mail className="w-4 h-4" />
              Get Help
            </Badge>
            <h2 className="text-3xl lg:text-5xl font-bold mb-6">Need Support?</h2>
            <p className="text-lg lg:text-xl text-gray-300 max-w-2xl mx-auto">
              Our team is here to help you get the most out of SlipScan
            </p>
          </div>
          
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
            <div className="text-center group">
              <div className="bg-purple-500/10 w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-4 sm:mb-6 group-hover:bg-purple-500/20 transition-colors duration-300">
                <Mail className="w-8 h-8 text-purple-400" />
              </div>
              <h3 className="text-xl font-bold mb-3">Email Support</h3>
              <p className="text-gray-400 mb-4">Quick help via email</p>
              <a 
                href="mailto:support@slipscan.com" 
                className="inline-flex items-center gap-2 bg-gradient-to-r from-purple-500 to-blue-500 text-white px-6 py-3 rounded-xl font-semibold hover:shadow-lg hover:text-white transition-all duration-300"
                target="_blank" 
                rel="noopener noreferrer"
              >
                <Mail className="w-4 h-4" />
                Email Us
              </a>
            </div>
            
            <div className="text-center group">
              <div className="bg-purple-500/10 w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-4 sm:mb-6 group-hover:bg-purple-500/20 transition-colors duration-300">
                <MessageSquare className="w-8 h-8 text-purple-400" />
              </div>
              <h3 className="text-xl font-bold mb-3">Live Chat</h3>
              <p className="text-gray-400 mb-4">Get instant assistance</p>
              <a 
                href="#" 
                className="inline-flex items-center gap-2 bg-gradient-to-r from-purple-500 to-blue-500 text-white px-6 py-3 rounded-xl font-semibold hover:shadow-lg hover:text-white transition-all duration-300"
              >
                <MessageSquare className="w-4 h-4" />
                Start Chat
              </a>
            </div>
            
            <div className="text-center group">
              <div className="bg-purple-500/10 w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-4 sm:mb-6 group-hover:bg-purple-500/20 transition-colors duration-300">
                <Phone className="w-8 h-8 text-purple-400" />
              </div>
              <h3 className="text-xl font-bold mb-3">Phone Support</h3>
              <p className="text-gray-400 mb-4">Speak directly with our team</p>
              <a 
                href="tel:+1234567890" 
                className="inline-flex items-center gap-2 bg-gradient-to-r from-purple-500 to-blue-500 text-white px-6 py-3 rounded-xl font-semibold hover:shadow-lg hover:text-white transition-all duration-300"
              >
                <Phone className="w-4 h-4" />
                Call Us
              </a>
            </div>
            
            <div className="text-center group">
              <div className="bg-purple-500/10 w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-4 sm:mb-6 group-hover:bg-purple-500/20 transition-colors duration-300">
                <FileText className="w-8 h-8 text-purple-400" />
              </div>
              <h3 className="text-xl font-bold mb-3">Documentation</h3>
              <p className="text-gray-400 mb-4">Self-service help guides</p>
              <a 
                href="/docs" 
                className="inline-flex items-center gap-2 bg-gradient-to-r from-purple-500 to-blue-500 text-white px-6 py-3 rounded-xl font-semibold hover:shadow-lg hover:text-white transition-all duration-300"
              >
                <FileText className="w-4 h-4" />
                View Docs
              </a>
            </div>
          </div>
          
          <div className="mt-8 sm:mt-12 lg:mt-16 text-center">
            <div className="bg-white/5 rounded-2xl p-6 sm:p-8 border border-white/10">
              <h3 className="text-2xl font-bold mb-4">Still Need Help?</h3>
              <p className="text-gray-300 mb-6">
                Our support team is available 24/7 to help you succeed with SlipScan
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Button 
                  className="bg-gradient-to-r from-purple-500 to-blue-500 text-white font-semibold px-8 py-3 rounded-xl shadow-lg hover:shadow-xl transition-all duration-300"
                  onClick={() => scrollToSection('get-started')}
                >
                  Schedule a Demo
                </Button>
                <Button 
                  variant="outline"
                  className="border-purple-500/30 text-purple-400 hover:bg-purple-500/10 hover:border-purple-500 font-semibold px-8 py-3 rounded-xl transition-all duration-300"
                  onClick={() => window.open('mailto:support@slipscan.com', '_blank')}
                >
                  <Mail className="w-4 h-4 mr-2" />
                  Email Us
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section id="get-started" className="bg-gradient-to-r from-purple-500 to-blue-500 text-white relative overflow-hidden py-12 sm:py-16 lg:py-32">
        <div className="absolute inset-0 bg-black/10"></div>
        <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-8 text-center">
          <Badge className="inline-flex items-center gap-2 bg-white/20 text-white px-4 py-2 text-sm font-semibold rounded-full mb-8">
            <Globe className="w-4 h-4" />
            Any Currency • Any Country
          </Badge>
          <h2 className="text-3xl lg:text-6xl font-bold leading-tight mb-8">
            Ready to Transform Your Financial Tracking?
          </h2>
          <p className="text-lg lg:text-2xl opacity-90 max-w-3xl mx-auto leading-relaxed mb-8 sm:mb-12">
            Join professionals using SlipScan to effortlessly track expenses, 
            extract insights from documents, and manage finances across all currencies.
          </p>
          <div className="flex flex-col sm:flex-row gap-6 justify-center">
            <Button 
              size="lg" 
              variant="secondary"
              className="bg-white text-purple-600 hover:bg-gray-100 shadow-lg h-16 px-10 text-xl font-bold rounded-2xl"
              onClick={() => navigate('/signup')}
            >
              Start Tracking Free
            </Button>
            <Button 
              size="lg" 
              variant="outline"
              className="border-2 border-white text-white bg-transparent hover:bg-white hover:text-purple-600 h-16 px-10 text-xl font-bold rounded-2xl"
            >
              Schedule a Demo
            </Button>
          </div>
          <div className="flex flex-wrap justify-center gap-8 pt-8 text-sm opacity-80">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4" />
              <span>Start for free</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4" />
              <span>AI-powered extraction</span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4" />
              <span>Global currency support</span>
            </div>
          </div>
        </div>
      </section>

      {/* Demo Modal */}
      <Dialog open={isDemoOpen} onOpenChange={setIsDemoOpen}>
        <DialogContent className="w-[95vw] max-w-md mx-auto">
          <DialogHeader className="pb-4">
            <DialogTitle className="text-center text-xl font-bold">
              {demoSuccess ? "Demo Sent! 🎉" : "Try SlipScan Demo"}
            </DialogTitle>
          </DialogHeader>

          {demoSuccess ? (
            <div className="py-6 text-center space-y-4">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <div className="space-y-2">
                <h3 className="text-lg font-semibold text-purple-600">Demo Complete!</h3>
                <p className="text-sm text-gray-600">
                  You've seen how SlipScan's AI processes documents and extracts line items. 
                  In production, this would be your actual receipt data!
                </p>
              </div>
              <Button 
                onClick={() => setIsDemoOpen(false)}
                className="bg-gradient-to-r from-purple-500 to-blue-500 text-white w-full"
              >
                Got it!
              </Button>
            </div>
          ) : (
            <form onSubmit={handleDemoSubmit} className="space-y-6">
              <div className="text-center space-y-2">
                <p className="text-gray-600">
                  Experience SlipScan's AI document processing!
                </p>
                <p className="text-xs text-purple-600 font-medium">
                  🌍 Global support for all currencies and document types
                </p>
              </div>

              {/* Error Alert */}
              {demoError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-sm">{demoError}</AlertDescription>
                </Alert>
              )}

              {/* Email Input */}
              <div className="space-y-2">
                <Label htmlFor="demo-email" className="text-sm font-medium">
                  Email Address
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                  <Input
                    id="demo-email"
                    type="email"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="your-email@example.com"
                    className="pl-10 h-12 text-lg"
                    required
                  />
                </div>
                <p className="text-xs text-gray-500">
                  Enter your email to see the demo processing flow
                </p>
              </div>

              {/* Submit Button */}
              <Button 
                type="submit"
                disabled={isLoading}
                className="bg-gradient-to-r from-purple-500 to-blue-500 text-white w-full h-12 text-lg font-semibold"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 w-5 h-5 animate-spin" />
                    Processing Demo...
                  </>
                ) : (
                  <>
                    <Brain className="mr-2 w-5 h-5" />
                    Start AI Demo
                  </>
                )}
              </Button>
              
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200 py-12 sm:py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 lg:gap-12">
            <div className="col-span-2 md:col-span-1 space-y-6">
              <Logo variant="minimal" className="text-left" />
              <p className="text-gray-600 max-w-md leading-relaxed flex items-start gap-2">
                <Brain className="w-5 h-5 mt-1 text-purple-500 flex-shrink-0" />
                SlipScan helps professionals and businesses track finances effortlessly with AI-powered 
                document processing and global currency support.
              </p>
            </div>
            
            <div>
              <h4 className="font-bold mb-6 text-lg text-gray-900">Product</h4>
              <ul className="space-y-3 text-gray-600">
                <li><button onClick={() => scrollToSection('features')} className="hover:text-purple-500 transition-colors text-left">Features</button></li>
                <li><button onClick={() => scrollToSection('how-it-works')} className="hover:text-purple-500 transition-colors text-left">How It Works</button></li>
                <li><button onClick={() => scrollToSection('testimonials')} className="hover:text-purple-500 transition-colors text-left">Reviews</button></li>
                <li><button onClick={() => scrollToSection('get-started')} className="hover:text-purple-500 transition-colors text-left">Demo</button></li>
              </ul>
            </div>
            
            <div>
              <h4 className="font-bold mb-6 text-lg text-gray-900">Navigation</h4>
              <ul className="space-y-3 text-gray-600">
                <li><button onClick={() => scrollToSection('home')} className="hover:text-purple-500 transition-colors text-left">Home</button></li>
                <li><button onClick={() => scrollToSection('stats')} className="hover:text-purple-500 transition-colors text-left">Stats</button></li>
                <li><button onClick={() => scrollToSection('benefits')} className="hover:text-purple-500 transition-colors text-left">Benefits</button></li>
                <li><button onClick={() => scrollToSection('support')} className="hover:text-purple-500 transition-colors text-left">Support</button></li>
              </ul>
            </div>
            
            <div>
              <h4 className="font-bold mb-6 text-lg text-gray-900">Resources</h4>
              <ul className="space-y-3 text-gray-600">
                <li><a href="/docs" className="hover:text-purple-500 transition-colors">Documentation</a></li>
                <li><a href="/docs/privacy" className="hover:text-purple-500 transition-colors">Privacy Policy</a></li>
                <li><a href="/docs/terms" className="hover:text-purple-500 transition-colors">Terms of Service</a></li>
                <li><a href="/docs/cookies" className="hover:text-purple-500 transition-colors">Cookie Policy</a></li>
              </ul>
            </div>
          </div>
          
          <div className="border-t border-gray-200 mt-8 sm:mt-12 pt-6 sm:pt-8">
            <div className="flex flex-col md:flex-row justify-between items-center space-y-4 md:space-y-0">
              <p className="text-gray-500">
                &copy; {new Date().getFullYear()} SlipScan is a member of Exolution Technologies Pty
              </p>
              <div className="flex items-center gap-4">
                <button 
                  onClick={() => scrollToSection('home')} 
                  className="text-gray-500 hover:text-purple-500 transition-colors text-sm"
                >
                  Back to Top
                </button>
              </div>
            </div>
          </div>
        </div>
      </footer>

      {/* Scroll to Top Button */}
      <ScrollToTop />
    </div>
  );
};

export default LandingPage;
