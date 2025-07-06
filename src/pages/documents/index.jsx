import React, { useState, useEffect, useMemo, useRef } from 'react';
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
  Sparkles,
  Trash2,
  Loader2
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from '@/services/supabase-client';

const DocumentsPage = () => {
  const { activeEntity, user } = useAuth();
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateRange, setDateRange] = useState('all');
  const fileInputRef = useRef(null);

  // Load documents when component mounts or active entity changes
  useEffect(() => {
    const loadDocuments = async () => {
      if (!activeEntity) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('documents')
          .select('*')
          .eq('entity_id', activeEntity.id)
          .order('created_at', { ascending: false });

        if (error) {
          console.error('Error loading documents:', error);
          return;
        }

        setDocuments(data || []);
      } catch (error) {
        console.error('Failed to load documents:', error);
      } finally {
        setLoading(false);
      }
    };

    loadDocuments();
  }, [activeEntity]);

  // Handle file upload - send directly to edge function
  const handleFileUpload = async (files) => {
    if (!files?.length || !activeEntity) return;

    setUploading(true);
    
    try {
      for (const file of files) {
        console.log(`📤 Starting upload: ${file.name}`);
        
        // Convert file to base64 for JSON transfer
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const base64String = btoa(String.fromCharCode(...uint8Array));

        // Send file and metadata to edge function
        const { data, error } = await supabase.functions.invoke('document-manager', {
          body: {
            file_data: base64String,
            file_name: file.name,
            mime_type: file.type,
            entity_id: activeEntity.id,
            document_type: 'receipt', // Default type, can be changed later
            uploaded_by: user?.email
          }
        });

        if (error) {
          console.error('❌ Error uploading file:', error);
          continue;
        }

        if (!data.success) {
          console.error('❌ Failed to upload file:', data.error);
          continue;
        }

        console.log(`✅ Document created successfully: ${file.name} (${data.document_id})`);
        console.log(`🔒 File hash: ${data.document_hash?.substring(0, 8)}...`);
      }

      // Reload documents
      loadDocuments();
    } catch (error) {
      console.error('❌ Upload error:', error);
    } finally {
      setUploading(false);
    }
  };

  // Handle file input change
  const handleFileInputChange = (event) => {
    const files = Array.from(event.target.files || []);
    handleFileUpload(files);
    // Clear input for next upload
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // View document
  const handleViewDocument = async (documentId) => {
    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/document-manager/${documentId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`
        }
      });

      const data = await response.json();

      if (response.ok && data.success && data.signed_url) {
        window.open(data.signed_url, '_blank');
      } else {
        console.error('Failed to get document:', data.error);
      }
    } catch (error) {
      console.error('Failed to view document:', error);
    }
  };

  // Delete document
  const handleDeleteDocument = async (documentId) => {
    if (!confirm('Are you sure you want to delete this document?')) return;

    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/document-manager/${documentId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`
        }
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setDocuments(docs => docs.filter(doc => doc.id !== documentId));
        console.log('✅ Document deleted successfully');
      } else {
        console.error('Failed to delete document:', data.error);
      }
    } catch (error) {
      console.error('Failed to delete document:', error);
    }
  };

  // Refresh documents
  const loadDocuments = async () => {
    if (!activeEntity) return;

    try {
      const { data, error } = await supabase
        .from('documents')
        .select('*')
        .eq('entity_id', activeEntity.id)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error loading documents:', error);
        return;
      }

      setDocuments(data || []);
    } catch (error) {
      console.error('Failed to load documents:', error);
    }
  };

  // Filter documents based on search and filters
  const filteredDocuments = useMemo(() => {
    let filtered = documents;

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter(doc => 
        doc.file_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        doc.entity_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        doc.document_type?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        doc.notes?.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    // Status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter(doc => doc.processing_status === statusFilter);
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
      
      filtered = filtered.filter(doc => new Date(doc.created_at) >= filterDate);
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
      case 'pending':
        return <AlertCircle className="w-4 h-4 text-blue-500" />;
      default:
        return <AlertCircle className="w-4 h-4 text-gray-500" />;
    }
  };

  const getStatusBadge = (status) => {
    const variants = {
      completed: 'bg-green-100 text-green-800 border-green-200',
      processing: 'bg-yellow-100 text-yellow-800 border-yellow-200',
      failed: 'bg-red-100 text-red-800 border-red-200',
      pending: 'bg-blue-100 text-blue-800 border-blue-200'
    };

    return (
      <Badge className={`${variants[status] || 'bg-gray-100 text-gray-800 border-gray-200'} border`}>
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
          <div className="flex items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileInputChange}
              className="hidden"
              accept=".pdf,.jpg,.jpeg,.png,.gif,.doc,.docx,.txt"
              multiple
            />
            <Button 
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="bg-gradient-to-r from-purple-500 to-blue-500 text-white shadow-lg hover:shadow-xl transition-all duration-300"
            >
              {uploading ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-2" />
              )}
              {uploading ? 'Uploading...' : 'Upload Document'}
            </Button>
          </div>
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
                    {documents.filter(d => d.processing_status === 'completed').length}
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
                    {documents.filter(d => d.processing_status === 'processing').length}
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
                        .filter(d => d.total_amount)
                        .reduce((sum, d) => sum + d.total_amount, 0),
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
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="processing">Processing</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
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
                  <Button 
                    className="bg-gradient-to-r from-purple-500 to-blue-500 text-white"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    {uploading ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4 mr-2" />
                    )}
                    {uploading ? 'Uploading...' : 'Upload Your First Document'}
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
                              <h3 className="font-semibold text-gray-900 truncate">{doc.file_name}</h3>
                              {getStatusIcon(doc.processing_status)}
                              {getStatusBadge(doc.processing_status)}
                            </div>
                            <p className="text-sm text-gray-500 mb-2">
                              Uploaded {formatDate(doc.created_at)}
                            </p>
                            
                            <div className="flex flex-wrap gap-2 text-sm">
                              {doc.total_amount && (
                                <span className="inline-flex items-center gap-1 text-gray-600">
                                  <DollarSign className="w-3 h-3" />
                                  {formatCurrency(doc.total_amount, 'USD')}
                                </span>
                              )}
                              {doc.entity_name && (
                                <span className="inline-flex items-center gap-1 text-gray-600">
                                  <Globe className="w-3 h-3" />
                                  {doc.entity_name}
                                </span>
                              )}
                              {doc.document_type && (
                                <span className="inline-flex items-center gap-1 text-gray-600">
                                  <Sparkles className="w-3 h-3" />
                                  {doc.document_type}
                                </span>
                              )}
                              {doc.source_type === 'email' && (
                                <span className="inline-flex items-center gap-1 text-blue-600">
                                  <Mail className="w-3 h-3" />
                                  Email
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 lg:flex-shrink-0">
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="border-gray-300 hover:border-purple-500"
                          onClick={() => handleViewDocument(doc.id)}
                        >
                          <Eye className="w-4 h-4 mr-2" />
                          View
                        </Button>
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="border-gray-300 hover:border-purple-500"
                          onClick={() => handleViewDocument(doc.id)}
                        >
                          <Download className="w-4 h-4 mr-2" />
                          Download
                        </Button>
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="border-gray-300 hover:border-red-500 text-red-600"
                          onClick={() => handleDeleteDocument(doc.id)}
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Delete
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
