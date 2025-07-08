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
  const [heroStep, setHeroStep] = React.useState(0);
  const [isAnimating, setIsAnimating] = React.useState(false);

  // Helper function to normalize phone numbers
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
      const normalizedPhone = normalizePhoneNumber(phoneNumber);

      if (!normalizedPhone || normalizedPhone.length < 10) {
        setDemoError('Please enter a valid phone number');
        setIsLoading(false);
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
    setHeroStep(1);
    
    setTimeout(() => {
      setHeroStep(2);
    }, 2000);
    
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
      title: "Email Integration",
      description: "Forward financial documents directly to your dedicated processing endpoint. No manual uploads required.",
      metrics: "99.9% uptime"
    },
    {
      icon: <Brain className="w-6 h-6" />,
      title: "AI Document Processing", 
      description: "Machine learning algorithms extract structured data from unstructured financial documents with enterprise-grade accuracy.",
      metrics: "< 3 sec processing"
    },
    {
      icon: <Globe className="w-6 h-6" />,
      title: "Multi-Currency Support",
      description: "Process documents in 150+ global currencies with real-time exchange rate integration and compliance reporting.",
      metrics: "150+ currencies"
    },
    {
      icon: <BarChart3 className="w-6 h-6" />,
      title: "Data Analytics Engine",
      description: "Advanced categorization algorithms with customizable taxonomy and real-time financial reporting capabilities.",
      metrics: "Real-time insights"
    },
    {
      icon: <Shield className="w-6 h-6" />,
      title: "Enterprise Security",
      description: "Bank-grade encryption, SOC 2 compliance, and zero-retention policy for sensitive financial document processing.",
      metrics: "SOC 2 certified"
    },
    {
      icon: <Database className="w-6 h-6" />,
      title: "API Infrastructure",
      description: "RESTful APIs with comprehensive documentation for seamless integration with existing financial management systems.",
      metrics: "99.99% availability"
    }
  ];

  const stats = [
    { number: "2.3M", label: "Documents Processed", icon: <FileText className="w-5 h-5" />, period: "Monthly" },
    { number: "150+", label: "Supported Currencies", icon: <Globe className="w-5 h-5" />, period: "Global" },
    { number: "99.94%", label: "Extraction Accuracy", icon: <Brain className="w-5 h-5" />, period: "Measured" },
    { number: "&lt; 2.8s", label: "Processing Speed", icon: <Zap className="w-5 h-5" />, period: "Average" }
  ];

  const testimonials = [
    {
      name: "Michael Chen",
      company: "FinTech Solutions Inc.",
      location: "New York, NY",
      rating: 5,
      text: "SlipScan reduced our document processing overhead by 89%. The API integration was seamless and the accuracy rate exceeds our internal benchmarks.",
      avatar: "MC",
      role: "Chief Technology Officer"
    },
    {
      name: "Sarah Rodriguez", 
      company: "Rodriguez & Associates CPA",
      location: "Los Angeles, CA",
      rating: 5,
      text: "Processing international client documents across multiple currencies is now automated. ROI was achieved within the first quarter of implementation.",
      avatar: "SR",
      role: "Managing Partner"
    },
    {
      name: "David Thompson",
      company: "Global Investment Partners",
      location: "London, UK", 
      rating: 5,
      text: "The machine learning accuracy for handwritten receipts and complex financial statements consistently exceeds 99%. Enterprise-grade reliability.",
      avatar: "DT",
      role: "Operations Director"
    }
  ];

  const processSteps = [
    {
      step: "01",
      title: "Email Endpoint Configuration",
      description: "Receive dedicated processing endpoint (format: entity@docs.slipscan.com). Configure email forwarding rules and security protocols.",
      icon: <Mail className="w-6 h-6" />,
      technical: "SMTP/IMAP integration"
    },
    {
      step: "02", 
      title: "Document Processing Pipeline",
      description: "AI algorithms extract structured data from financial documents. OCR, NLP, and ML models process text, tables, and metadata.",
      icon: <Brain className="w-6 h-6" />,
      technical: "< 3 second processing"
    },
    {
      step: "03",
      title: "Data Validation & Export", 
      description: "Structured output with confidence scores, validation reports, and export to CSV, JSON, or direct API integration.",
      icon: <Database className="w-6 h-6" />,
      technical: "99.94% accuracy rate"
    }
  ];

  return (
    <div className="min-h-screen bg-white">
      {/* Hero Section - Bloomberg Terminal Inspired */}
      <section id="home" className="bg-white border-b border-gray-200">
        <div className="corporate-container">
          <div className="grid lg:grid-cols-12 gap-16 py-24">
            {/* Left Content - Information Dense */}
            <div className="lg:col-span-7 space-y-8">
              <div className="space-y-6">
                <div className="inline-flex items-center gap-3 bg-gray-50 border border-gray-200 px-4 py-2">
                  <div className="w-2 h-2 bg-blue-600 rounded-full"></div>
                  <span className="text-sm font-medium text-gray-900 tracking-wide">ENTERPRISE FINANCIAL PROCESSING</span>
                </div>
                
                <h1 className="text-5xl lg:text-6xl font-black leading-none tracking-tight text-gray-900">
                  AI-POWERED<br />
                  DOCUMENT<br />
                  <span className="text-blue-600">PROCESSING</span>
                </h1>
                
                <div className="space-y-4">
                  <p className="text-xl text-gray-600 leading-relaxed max-w-2xl">
                    Enterprise-grade financial document processing with machine learning precision. 
                    Email integration, multi-currency support, real-time analytics.
                  </p>
                  
                  {/* Key metrics bar */}
                  <div className="grid grid-cols-3 gap-6 py-6 border-t border-b border-gray-200">
                    <div>
                      <div className="font-mono text-lg font-bold text-gray-900">99.94%</div>
                      <div className="text-sm text-gray-600">Accuracy Rate</div>
                    </div>
                    <div>
                      <div className="font-mono text-lg font-bold text-gray-900">&lt; 2.8s</div>
                      <div className="text-sm text-gray-600">Processing Time</div>
                    </div>
                    <div>
                      <div className="font-mono text-lg font-bold text-gray-900">150+</div>
                      <div className="text-sm text-gray-600">Currencies</div>
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="flex gap-4">
                <Button 
                  className="bg-blue-600 text-white border border-blue-600 h-12 px-8 font-semibold hover:bg-blue-700 transition-colors"
                  onClick={() => navigate('/signup')}
                >
                  START PROCESSING
                  <ArrowRight className="ml-2 w-4 h-4" />
                </Button>
                <Button 
                  variant="outline" 
                  className="border-gray-300 text-gray-900 h-12 px-8 font-semibold hover:border-blue-600 hover:bg-gray-50 transition-colors"
                  onClick={openDemo}
                >
                  VIEW DEMO
                </Button>
              </div>
            </div>

            {/* Right Visual - Data Processing Interface */}
            <div className="lg:col-span-5">
              {heroStep === 0 && (
                <div className="corporate-card-elevated p-6">
                  <div className="flex items-center justify-between border-b border-gray-200 pb-4 mb-6">
                    <div className="flex items-center gap-3">
                      <div className="w-3 h-3 bg-red-500"></div>
                      <div className="w-3 h-3 bg-yellow-500"></div>
                      <div className="w-3 h-3 bg-green-500"></div>
                    </div>
                    <span className="text-sm font-mono text-gray-600">inbox@docs.slipscan.com</span>
                  </div>
                  
                  <div className="space-y-4">
                    <div className="bg-gray-50 border border-gray-200 p-4">
                      <div className="flex items-start gap-3 mb-3">
                        <Mail className="w-4 h-4 text-gray-600 mt-1" />
                        <div className="flex-1">
                          <div className="text-sm font-medium text-gray-900">Financial Document Processing</div>
                          <div className="text-xs text-gray-600 font-mono">To: abc123@docs.slipscan.com</div>
                        </div>
                      </div>
                      <div className="bg-white border border-gray-200 p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <Receipt className="w-4 h-4 text-gray-600" />
                          <span className="text-sm font-mono text-gray-900">invoice_Q4_2024.pdf</span>
                        </div>
                        <div className="text-xs text-gray-500 font-mono">247 KB • Ready for processing</div>
                      </div>
                    </div>

                    <Button 
                      onClick={startHeroAnimation}
                      disabled={isAnimating}
                      className="w-full bg-blue-600 text-white font-semibold h-10 hover:bg-blue-700 transition-colors"
                    >
                      <Upload className="mr-2 w-4 h-4" />
                      PROCESS DOCUMENT
                    </Button>
                  </div>
                </div>
              )}

              {heroStep === 1 && (
                <div className="corporate-card-elevated p-6">
                  <div className="flex items-center gap-3 border-b border-gray-200 pb-4 mb-6">
                    <div className="w-3 h-3 bg-blue-600 animate-pulse"></div>
                    <span className="text-sm font-semibold text-gray-900">AI PROCESSING ENGINE</span>
                  </div>
                  
                  <div className="text-center space-y-6">
                    <div className="w-16 h-16 bg-gray-100 border border-gray-200 flex items-center justify-center mx-auto">
                      <Brain className="w-8 h-8 text-blue-600" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-gray-900 mb-2">EXTRACTING DATA</h3>
                      <p className="text-sm text-gray-600">Machine learning algorithms analyzing document structure...</p>
                    </div>
                    <div className="flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                      <span className="text-xs font-mono text-gray-500">Processing in progress...</span>
                    </div>
                  </div>
                </div>
              )}

              {heroStep === 2 && (
                <div className="space-y-4">
                  <div className="corporate-card p-4">
                    <div className="flex items-center justify-between border-b border-gray-200 pb-3 mb-4">
                      <div className="flex items-center gap-2">
                        <Receipt className="w-4 h-4 text-gray-600" />
                        <span className="font-semibold text-gray-900">Invoice #INV-2024-Q4</span>
                      </div>
                      <span className="text-xs bg-gray-100 border border-gray-200 px-2 py-1 font-mono">PROCESSED</span>
                    </div>
                    
                    <div className="space-y-2 font-mono text-sm">
                      <div className="flex justify-between py-1 border-b border-gray-100">
                        <span className="text-gray-600">Vendor:</span>
                        <span className="text-gray-900 font-semibold">TechCorp Solutions</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-gray-100">
                        <span className="text-gray-600">Amount:</span>
                        <span className="text-gray-900 font-bold">$2,847.50</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-gray-100">
                        <span className="text-gray-600">Date:</span>
                        <span className="text-gray-900">2024-12-15</span>
                      </div>
                      <div className="flex justify-between py-1">
                        <span className="text-gray-600">Category:</span>
                        <span className="text-blue-600 font-semibold">SOFTWARE_LICENSES</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-gray-50 border border-gray-200 p-4 text-center">
                    <div className="flex items-center justify-center gap-2 mb-2">
                      <CheckCircle className="w-5 h-5 text-green-600" />
                      <span className="font-semibold text-gray-900">DATA EXTRACTED</span>
                    </div>
                    <p className="text-xs text-gray-600 mb-3">Document processed with 99.8% confidence score</p>
                    <Button 
                      onClick={startHeroAnimation}
                      variant="outline"
                      className="border-gray-300 text-gray-900 text-xs h-8 px-4 hover:border-blue-600"
                    >
                      <Play className="mr-1 w-3 h-3" />
                      REPLAY DEMO
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
            {/* Removed benefits array as per edit hint */}
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
            {/* Removed steps array as per edit hint */}
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
