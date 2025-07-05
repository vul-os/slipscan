import React, { useState, useEffect } from 'react';
import { useAuth } from '@/context/auth-context';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  Brain, 
  FileText, 
  DollarSign, 
  TrendingUp, 
  Clock, 
  CheckCircle,
  Upload,
  Mail,
  Globe,
  Sparkles,
  BarChart3,
  Calendar,
  ArrowRight,
  Eye
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

// Mock dashboard data - replace with real API calls
const mockDashboardData = {
  totalDocuments: 47,
  processedThisMonth: 23,
  totalValue: 2847.65,
  monthlyGrowth: 12.5,
  recentDocuments: [
    {
      id: 1,
      filename: 'starbucks_receipt_march15.pdf',
      upload_date: '2024-03-15T10:30:00Z',
      status: 'completed',
      total: 10.04,
      vendor: 'Starbucks Downtown'
    },
    {
      id: 2,
      filename: 'uber_receipt_march14.pdf',
      upload_date: '2024-03-14T18:45:00Z',
      status: 'completed',
      total: 23.50,
      vendor: 'Uber'
    },
    {
      id: 3,
      filename: 'office_supplies_march13.pdf',
      upload_date: '2024-03-13T14:20:00Z',
      status: 'processing',
      total: null,
      vendor: null
    }
  ],
  categories: [
    { name: 'Business Meals', amount: 456.78, count: 12 },
    { name: 'Transportation', amount: 234.50, count: 8 },
    { name: 'Office Supplies', amount: 890.12, count: 15 },
    { name: 'Travel', amount: 1266.25, count: 12 }
  ]
};

const DashboardPage = () => {
  const { activeEntity, user } = useAuth();
  const navigate = useNavigate();
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadDashboardData = async () => {
      setLoading(true);
      try {
        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 600));
        setDashboardData(mockDashboardData);
      } catch (error) {
        console.error('Failed to load dashboard data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadDashboardData();
  }, [activeEntity]);

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (!activeEntity && !loading) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <div className="w-16 h-16 bg-gradient-to-r from-purple-500 to-blue-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Brain className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">No Entity Selected</h2>
          <p className="text-gray-600">Please select an entity to view your dashboard.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">
              Welcome back, {user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User'}
            </h1>
            <p className="text-gray-600">
              Here's what's happening with {activeEntity?.name || 'your entity'} today
            </p>
          </div>
          <Button 
            className="bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow-lg hover:shadow-xl transition-all duration-300"
            onClick={() => navigate('/documents')}
          >
            <Upload className="w-4 h-4 mr-2" />
            Upload Document
          </Button>
        </div>

        {loading ? (
          <div className="text-center py-12">
            <div className="w-12 h-12 bg-gradient-to-r from-purple-500 to-blue-500 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
              <Brain className="w-6 h-6 text-white" />
            </div>
            <p className="text-gray-600">Loading your AI-powered insights...</p>
          </div>
        ) : (
          <>
            {/* Key Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <Card className="border-2 border-gray-200 hover:border-purple-300 transition-colors">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-600">Total Documents</p>
                      <p className="text-3xl font-bold text-gray-900">{dashboardData.totalDocuments}</p>
                      <p className="text-sm text-gray-500">All time</p>
                    </div>
                    <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
                      <FileText className="w-6 h-6 text-purple-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-2 border-gray-200 hover:border-green-300 transition-colors">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-600">This Month</p>
                      <p className="text-3xl font-bold text-gray-900">{dashboardData.processedThisMonth}</p>
                      <p className="text-sm text-green-600 flex items-center">
                        <TrendingUp className="w-3 h-3 mr-1" />
                        +{dashboardData.monthlyGrowth}%
                      </p>
                    </div>
                    <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
                      <CheckCircle className="w-6 h-6 text-green-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-2 border-gray-200 hover:border-blue-300 transition-colors">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-600">Total Value</p>
                      <p className="text-3xl font-bold text-gray-900">
                        {formatCurrency(dashboardData.totalValue)}
                      </p>
                      <p className="text-sm text-gray-500">Tracked expenses</p>
                    </div>
                    <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                      <DollarSign className="w-6 h-6 text-blue-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-2 border-gray-200 hover:border-orange-300 transition-colors">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-600">AI Processing</p>
                      <p className="text-3xl font-bold text-gray-900">99.9%</p>
                      <p className="text-sm text-gray-500">Accuracy rate</p>
                    </div>
                    <div className="w-12 h-12 bg-orange-100 rounded-lg flex items-center justify-center">
                      <Brain className="w-6 h-6 text-orange-600" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Recent Documents */}
              <Card className="lg:col-span-2 border-2 border-gray-200">
                <CardHeader className="pb-4">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <Clock className="w-5 h-5 text-purple-600" />
                      Recent Documents
                    </CardTitle>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => navigate('/documents')}
                      className="border-gray-300 hover:border-purple-500"
                    >
                      View All
                      <ArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="divide-y divide-gray-200">
                    {dashboardData.recentDocuments.map((doc) => (
                      <div key={doc.id} className="p-4 hover:bg-gray-50 transition-colors">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
                              <FileText className="w-4 h-4 text-purple-600" />
                            </div>
                            <div>
                              <h4 className="font-medium text-gray-900 text-sm">{doc.filename}</h4>
                              <div className="flex items-center gap-2 text-xs text-gray-500">
                                <span>{formatDate(doc.upload_date)}</span>
                                {doc.vendor && (
                                  <>
                                    <span>•</span>
                                    <span>{doc.vendor}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {doc.total && (
                              <span className="text-sm font-semibold text-gray-900">
                                {formatCurrency(doc.total)}
                              </span>
                            )}
                            <Badge className={`text-xs ${
                              doc.status === 'completed' 
                                ? 'bg-green-100 text-green-800 border-green-200'
                                : 'bg-yellow-100 text-yellow-800 border-yellow-200'
                            } border`}>
                              {doc.status === 'completed' ? 'Processed' : 'Processing'}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Top Categories */}
              <Card className="border-2 border-gray-200">
                <CardHeader className="pb-4">
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="w-5 h-5 text-purple-600" />
                    Top Categories
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {dashboardData.categories.map((category, index) => (
                    <div key={category.name} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-gradient-to-r from-purple-500 to-blue-500 rounded-lg flex items-center justify-center text-white text-xs font-bold">
                          {index + 1}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900 text-sm">{category.name}</p>
                          <p className="text-xs text-gray-500">{category.count} documents</p>
                        </div>
                      </div>
                      <span className="text-sm font-semibold text-gray-900">
                        {formatCurrency(category.amount)}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>

            {/* Quick Actions */}
            <Card className="border-2 border-purple-200 bg-purple-50/50">
              <CardContent className="p-6">
                <div className="flex flex-col md:flex-row items-start md:items-center gap-4">
                  <div className="flex-1">
                    <h3 className="font-semibold text-purple-900 mb-2 flex items-center gap-2">
                      <Mail className="w-5 h-5" />
                      Email documents for instant AI processing
                    </h3>
                    <p className="text-purple-800 mb-3">
                      Send receipts, invoices, and statements to your unique email address.
                    </p>
                    <div className="bg-white px-4 py-2 rounded-lg border border-purple-200 font-mono text-sm text-purple-900 inline-block">
                      {activeEntity?.id ? `${activeEntity.id}@docs.slipscan.com` : 'your-entity@docs.slipscan.com'}
                    </div>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button 
                      className="bg-gradient-to-r from-purple-500 to-blue-500 text-white"
                      onClick={() => navigate('/documents')}
                    >
                      <Eye className="w-4 h-4 mr-2" />
                      View Documents
                    </Button>
                    <Button 
                      variant="outline" 
                      className="border-purple-300 text-purple-700 hover:bg-purple-100"
                    >
                      <Calendar className="w-4 h-4 mr-2" />
                      View Reports
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* AI Features Highlight */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card className="border-2 border-gray-200 text-center">
                <CardContent className="p-6">
                  <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Brain className="w-6 h-6 text-purple-600" />
                  </div>
                  <h3 className="font-semibold text-gray-900 mb-2">AI Extraction</h3>
                  <p className="text-sm text-gray-600">
                    Automatically extract line items, totals, and vendor details from any document.
                  </p>
                </CardContent>
              </Card>

              <Card className="border-2 border-gray-200 text-center">
                <CardContent className="p-6">
                  <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Globe className="w-6 h-6 text-blue-600" />
                  </div>
                  <h3 className="font-semibold text-gray-900 mb-2">Global Currency</h3>
                  <p className="text-sm text-gray-600">
                    Process documents in any currency from anywhere in the world.
                  </p>
                </CardContent>
              </Card>

              <Card className="border-2 border-gray-200 text-center">
                <CardContent className="p-6">
                  <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Sparkles className="w-6 h-6 text-green-600" />
                  </div>
                  <h3 className="font-semibold text-gray-900 mb-2">Smart Categorization</h3>
                  <p className="text-sm text-gray-600">
                    AI automatically categorizes expenses for better financial insights.
                  </p>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default DashboardPage;
