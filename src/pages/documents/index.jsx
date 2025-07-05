import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/context/auth-context';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { 
  Search, 
  Calendar, 
  FileText, 
  Brain, 
  Eye, 
  Download, 
  Filter,
  Upload,
  DollarSign,
  Clock,
  CheckCircle,
  AlertCircle,
  XCircle,
  Mail,
  Globe,
  Sparkles
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Mock documents data - replace with real API calls
const mockDocuments = [
  {
    id: 1,
    filename: 'starbucks_receipt_march15.pdf',
    upload_date: '2024-03-15T10:30:00Z',
    status: 'completed',
    extracted_data: {
      total: 10.04,
      currency: 'USD',
      vendor: 'Starbucks Downtown',
      line_items: 3,
      category: 'Business Meals'
    },
    entity_id: 1
  },
  {
    id: 2,
    filename: 'uber_receipt_march14.pdf',
    upload_date: '2024-03-14T18:45:00Z',
    status: 'completed',
    extracted_data: {
      total: 23.50,
      currency: 'USD',
      vendor: 'Uber',
      line_items: 1,
      category: 'Transportation'
    },
    entity_id: 1
  },
  {
    id: 3,
    filename: 'office_supplies_march13.pdf',
    upload_date: '2024-03-13T14:20:00Z',
    status: 'processing',
    extracted_data: null,
    entity_id: 1
  },
  {
    id: 4,
    filename: 'hotel_invoice_march12.pdf',
    upload_date: '2024-03-12T09:15:00Z',
    status: 'failed',
    extracted_data: null,
    entity_id: 1
  },
  {
    id: 5,
    filename: 'amazon_business_march11.pdf',
    upload_date: '2024-03-11T16:30:00Z',
    status: 'completed',
    extracted_data: {
      total: 156.78,
      currency: 'USD',
      vendor: 'Amazon Business',
      line_items: 8,
      category: 'Office Supplies'
    },
    entity_id: 1
  }
];

const DocumentsPage = () => {
  const { activeEntity, user } = useAuth();
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateRange, setDateRange] = useState('all');

  // Load documents when component mounts or active entity changes
  useEffect(() => {
    const loadDocuments = async () => {
      setLoading(true);
      try {
        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 800));
        
        // Filter documents by active entity
        const entityDocuments = activeEntity 
          ? mockDocuments.filter(doc => doc.entity_id === activeEntity.id)
          : mockDocuments;
        
        setDocuments(entityDocuments);
      } catch (error) {
        console.error('Failed to load documents:', error);
      } finally {
        setLoading(false);
      }
    };

    loadDocuments();
  }, [activeEntity]);

  // Filter documents based on search and filters
  const filteredDocuments = useMemo(() => {
    let filtered = documents;

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter(doc => 
        doc.filename.toLowerCase().includes(searchQuery.toLowerCase()) ||
        doc.extracted_data?.vendor?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        doc.extracted_data?.category?.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter(doc => doc.status === statusFilter);
    }

    // Date range filter
    if (dateRange !== 'all') {
      const now = new Date();
      const filterDate = new Date();
      
      switch (dateRange) {
        case 'today':
          filterDate.setHours(0, 0, 0, 0);
          break;
        case 'week':
          filterDate.setDate(now.getDate() - 7);
          break;
        case 'month':
          filterDate.setDate(now.getDate() - 30);
          break;
        default:
          return filtered;
      }
      
      filtered = filtered.filter(doc => new Date(doc.upload_date) >= filterDate);
    }

    return filtered;
  }, [documents, searchQuery, statusFilter, dateRange]);

  const getStatusIcon = (status) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'processing':
        return <Clock className="w-4 h-4 text-yellow-500" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-500" />;
      default:
        return <AlertCircle className="w-4 h-4 text-gray-500" />;
    }
  };

  const getStatusBadge = (status) => {
    const variants = {
      completed: 'bg-green-100 text-green-800 border-green-200',
      processing: 'bg-yellow-100 text-yellow-800 border-yellow-200',
      failed: 'bg-red-100 text-red-800 border-red-200'
    };

    return (
      <Badge className={`${variants[status]} border`}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    );
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatCurrency = (amount, currency) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD'
    }).format(amount);
  };

  if (!activeEntity && !loading) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <div className="w-16 h-16 bg-gradient-to-r from-purple-500 to-blue-500 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Brain className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">No Entity Selected</h2>
          <p className="text-gray-600">Please select an entity to view documents.</p>
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
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Documents</h1>
            <p className="text-gray-600">
              AI-powered document processing for {activeEntity?.name || 'your entity'}
            </p>
          </div>
          <Button className="bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow-lg hover:shadow-xl transition-all duration-300">
            <Upload className="w-4 h-4 mr-2" />
            Upload Document
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="border-2 border-gray-200 hover:border-purple-300 transition-colors">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Total Documents</p>
                  <p className="text-2xl font-bold text-gray-900">{documents.length}</p>
                </div>
                <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                  <FileText className="w-5 h-5 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-2 border-gray-200 hover:border-green-300 transition-colors">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Processed</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {documents.filter(d => d.status === 'completed').length}
                  </p>
                </div>
                <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-2 border-gray-200 hover:border-yellow-300 transition-colors">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Processing</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {documents.filter(d => d.status === 'processing').length}
                  </p>
                </div>
                <div className="w-10 h-10 bg-yellow-100 rounded-lg flex items-center justify-center">
                  <Clock className="w-5 h-5 text-yellow-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-2 border-gray-200 hover:border-blue-300 transition-colors">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Total Value</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {formatCurrency(
                      documents
                        .filter(d => d.extracted_data?.total)
                        .reduce((sum, d) => sum + d.extracted_data.total, 0),
                      'USD'
                    )}
                  </p>
                </div>
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <DollarSign className="w-5 h-5 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card className="border-2 border-gray-200">
          <CardContent className="p-6">
            <div className="flex flex-col lg:flex-row gap-4">
              {/* Search */}
              <div className="flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder="Search documents, vendors, categories..."
                    className="pl-9 h-10 border-gray-300 focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>

              {/* Status Filter */}
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full lg:w-48 h-10 border-gray-300 focus:border-purple-500">
                  <Filter className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="processing">Processing</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>

              {/* Date Range Filter */}
              <Select value={dateRange} onValueChange={setDateRange}>
                <SelectTrigger className="w-full lg:w-48 h-10 border-gray-300 focus:border-purple-500">
                  <Calendar className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="All Time" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Time</SelectItem>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="week">Last 7 Days</SelectItem>
                  <SelectItem value="month">Last 30 Days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Documents List */}
        <Card className="border-2 border-gray-200">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2">
              <Brain className="w-5 h-5 text-purple-600" />
              Documents ({filteredDocuments.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="p-8 text-center">
                <div className="w-12 h-12 bg-gradient-to-r from-purple-500 to-blue-500 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
                  <Brain className="w-6 h-6 text-white" />
                </div>
                <p className="text-gray-600">Processing documents with AI...</p>
              </div>
            ) : filteredDocuments.length === 0 ? (
              <div className="p-8 text-center">
                <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <FileText className="w-8 h-8 text-gray-400" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">No documents found</h3>
                <p className="text-gray-600 mb-4">
                  {searchQuery || statusFilter !== 'all' || dateRange !== 'all'
                    ? 'No documents match your current filters.'
                    : 'Start by uploading your first document for AI processing.'}
                </p>
                {(!searchQuery && statusFilter === 'all' && dateRange === 'all') && (
                  <Button className="bg-gradient-to-r from-purple-500 to-blue-500 text-white">
                    <Upload className="w-4 h-4 mr-2" />
                    Upload Your First Document
                  </Button>
                )}
              </div>
            ) : (
              <div className="divide-y divide-gray-200">
                {filteredDocuments.map((doc) => (
                  <div key={doc.id} className="p-6 hover:bg-gray-50 transition-colors">
                    <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                      {/* Document Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center flex-shrink-0">
                            <FileText className="w-5 h-5 text-purple-600" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-semibold text-gray-900 truncate">{doc.filename}</h3>
                              {getStatusIcon(doc.status)}
                              {getStatusBadge(doc.status)}
                            </div>
                            <p className="text-sm text-gray-500 mb-2">
                              Uploaded {formatDate(doc.upload_date)}
                            </p>
                            
                            {doc.extracted_data && (
                              <div className="flex flex-wrap gap-2 text-sm">
                                <span className="inline-flex items-center gap-1 text-gray-600">
                                  <DollarSign className="w-3 h-3" />
                                  {formatCurrency(doc.extracted_data.total, doc.extracted_data.currency)}
                                </span>
                                <span className="inline-flex items-center gap-1 text-gray-600">
                                  <Globe className="w-3 h-3" />
                                  {doc.extracted_data.vendor}
                                </span>
                                <span className="inline-flex items-center gap-1 text-gray-600">
                                  <Sparkles className="w-3 h-3" />
                                  {doc.extracted_data.category}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 lg:flex-shrink-0">
                        <Button variant="outline" size="sm" className="border-gray-300 hover:border-purple-500">
                          <Eye className="w-4 h-4 mr-2" />
                          View
                        </Button>
                        <Button variant="outline" size="sm" className="border-gray-300 hover:border-purple-500">
                          <Download className="w-4 h-4 mr-2" />
                          Download
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Email Instructions */}
        <Card className="border-2 border-purple-200 bg-purple-50/50">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-gradient-to-r from-purple-500 to-blue-500 rounded-xl flex items-center justify-center flex-shrink-0">
                <Mail className="w-6 h-6 text-white" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-purple-900 mb-2">
                  Email documents for instant AI processing
                </h3>
                <p className="text-purple-800 mb-3">
                  Send receipts, invoices, and statements to your unique email address for automatic processing.
                </p>
                <div className="bg-white px-4 py-2 rounded-lg border border-purple-200 font-mono text-sm text-purple-900">
                  {activeEntity?.id ? `${activeEntity.id}@docs.slipscan.com` : 'your-entity@docs.slipscan.com'}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default DocumentsPage;
