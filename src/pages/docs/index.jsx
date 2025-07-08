import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight, FileText, Home, Settings, Users, Zap, HelpCircle, Book, Code, Shield } from 'lucide-react';

const DocsPage = () => {
  const { section } = useParams();
  const navigate = useNavigate();
  const [currentSection, setCurrentSection] = useState(section || 'overview');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [activeNav, setActiveNav] = useState('overview');

  // Navigation structure
  const navigation = [
    {
      title: 'Getting Started',
      items: [
        { id: 'overview', title: 'Overview', icon: Home },
        { id: 'getting-started', title: 'Quick Start', icon: Zap },
        { id: 'setup', title: 'Setup & Installation', icon: Settings },
      ]
    },
    {
      title: 'User Guide',
      items: [
        { id: 'user-guide', title: 'Complete Guide', icon: Book },
        { id: 'features', title: 'Features', icon: FileText },
      ]
    },
    {
      title: 'Technical',
      items: [
        { id: 'api-reference', title: 'API Reference', icon: Code },
        { id: 'troubleshooting', title: 'Troubleshooting', icon: Shield },
      ]
    },
    {
      title: 'Support',
      items: [
        { id: 'faq', title: 'FAQ', icon: HelpCircle },
      ]
    }
  ];

  // Content mapping
  const contentMap = {
    'overview': `
# SlipScan Documentation

Welcome to SlipScan - AI-Powered Document Processing Platform

## 📋 Overview

SlipScan is a comprehensive document processing platform that leverages artificial intelligence to automatically extract, analyze, and organize data from various document types. Perfect for businesses that need to process receipts, invoices, contracts, and other documents efficiently.

## ✨ Key Features

- **AI-Powered Processing**: Automatically extract data from documents using advanced OCR and AI
- **Multi-Entity Support**: Manage documents for multiple businesses or departments
- **Real-time Status Tracking**: Monitor document processing status in real-time
- **Financial Analytics**: Extract and analyze financial data from receipts and invoices
- **Secure Storage**: Enterprise-grade security for document storage and processing
- **Team Collaboration**: Invite team members and manage permissions

## 🛠️ Tech Stack

- **Frontend**: React 19, Vite, Tailwind CSS
- **UI Components**: Radix UI, shadcn/ui
- **Backend**: Supabase, Firebase
- **AI Processing**: Custom document processing pipeline
- **Authentication**: Supabase Auth
- **Storage**: Supabase Storage

## 🚀 Quick Navigation

- **[Getting Started](getting-started)** - Set up your first document processing workflow
- **[User Guide](user-guide)** - Complete guide for using all features
- **[API Reference](api-reference)** - Technical documentation for developers
- **[Features](features)** - Detailed feature overview
- **[Troubleshooting](troubleshooting)** - Common issues and solutions

## 🤝 Support

- **Documentation**: Browse this comprehensive documentation
- **Issues**: Report bugs and feature requests
- **Community**: Join our community discussions

---

*Last updated: December 2024*
    `,
    'getting-started': `
# Getting Started with SlipScan

Welcome to SlipScan! This guide will help you get up and running with AI-powered document processing.

## 🎯 What is SlipScan?

SlipScan is an intelligent document processing platform that automatically extracts, analyzes, and organizes data from your documents using artificial intelligence. Whether you're processing receipts, invoices, contracts, or other business documents, SlipScan streamlines your workflow.

## 🚀 Quick Start

### Step 1: Sign Up

1. Visit the SlipScan application
2. Click "Sign Up" to create your account
3. Verify your email address
4. Complete your profile setup

### Step 2: Create Your First Entity

An entity represents your business, department, or organization:

1. Click "Create Entity" on your dashboard
2. Enter your entity name and details
3. Set up entity preferences
4. Invite team members (optional)

### Step 3: Upload Your First Document

1. Navigate to the Documents page
2. Click "Upload Document"
3. Select your file (PDF, JPG, PNG, DOC, etc.)
4. Watch as AI processes your document automatically

### Step 4: Review Processed Data

1. Check the processing status in real-time
2. Review extracted data and insights
3. Make any necessary corrections
4. Export or analyze your data

## 📁 Supported File Types

SlipScan supports a wide variety of document formats:

- **Images**: JPG, JPEG, PNG, GIF
- **Documents**: PDF, DOC, DOCX, TXT
- **Maximum file size**: 10MB per file
- **Batch upload**: Upload multiple files at once

## 🎯 Best Practices

### For Optimal Processing

1. **High Quality Images**: Use clear, well-lit photos
2. **Proper Orientation**: Ensure documents are right-side up
3. **Full Document**: Capture the entire document
4. **Good Contrast**: Ensure text is clearly visible

### Document Organization

1. **Consistent Naming**: Use descriptive file names
2. **Regular Processing**: Process documents regularly
3. **Review Accuracy**: Always review AI-extracted data
4. **Use Categories**: Organize documents by type

---

Ready to process your documents? Let's get started!
    `,
    'user-guide': `
# SlipScan User Guide

Complete guide for using SlipScan's AI-powered document processing platform.

## 📋 Table of Contents

1. [Dashboard Overview](#dashboard-overview)
2. [Entity Management](#entity-management)
3. [Document Processing](#document-processing)
4. [Data Analysis](#data-analysis)
5. [Team Collaboration](#team-collaboration)
6. [Settings & Configuration](#settings--configuration)

## 🏠 Dashboard Overview

The SlipScan dashboard is your central hub for managing all document processing activities.

### Key Metrics

- **Total Documents**: View total number of processed documents
- **Processing Status**: See documents currently being processed
- **Financial Summary**: Overview of extracted financial data
- **Recent Activity**: Latest uploads and processing results

### Quick Actions

- Upload new documents
- View recent documents
- Access analytics
- Manage entities

## 🏢 Entity Management

Entities represent different businesses, departments, or organizations you manage.

### Creating an Entity

1. Click "Create Entity" from the dashboard
2. Fill in required information:
   - Entity name
   - Business type
   - Contact information
   - Address details
3. Configure processing preferences
4. Save and activate

### Entity Settings

Each entity can have customized settings:
- **Document Categories**: Define custom categories
- **Processing Rules**: Set up automatic processing rules
- **Team Access**: Control who can access entity documents
- **Notification Preferences**: Configure alerts and notifications

## 📄 Document Processing

SlipScan's core feature is intelligent document processing using AI.

### Uploading Documents

#### Single Upload
1. Click "Upload Document"
2. Select file from your device
3. Choose document category (optional)
4. Add notes or tags (optional)
5. Click "Upload"

#### Batch Upload
1. Select multiple files at once
2. Documents will be processed automatically
3. Monitor progress in real-time

### Processing Stages

Documents go through several processing stages:

1. **Upload**: File is uploaded to secure storage
2. **Pending**: Document queued for processing
3. **Processing**: AI extracts data and analyzes content
4. **Completed**: Processing finished, data available
5. **Failed**: Processing encountered errors

---

This user guide covers all major features of SlipScan. For technical details, see the API Reference.
    `,
    'features': `
# SlipScan Features

Comprehensive overview of SlipScan's AI-powered document processing capabilities.

## 🤖 AI Document Processing

### Intelligent OCR
- **Advanced Text Recognition**: State-of-the-art OCR technology
- **Multi-language Support**: Process documents in multiple languages
- **Handwriting Recognition**: Extract handwritten text and signatures
- **Table Detection**: Automatically identify and extract table data

### Smart Data Extraction
- **Structured Data**: Extract fields, forms, and structured information
- **Financial Data**: Automatically identify amounts, taxes, and totals
- **Date Recognition**: Parse and standardize date formats
- **Entity Recognition**: Identify vendors, customers, and organizations

### Document Classification
- **Automatic Categorization**: AI classifies documents by type
- **Custom Categories**: Create and train custom document categories
- **Confidence Scoring**: View AI confidence levels for classifications
- **Manual Override**: Easily correct or adjust classifications

## 📁 Document Management

### File Support
- **Multiple Formats**: PDF, JPG, PNG, GIF, DOC, DOCX, TXT
- **Batch Processing**: Upload and process multiple files simultaneously
- **Size Optimization**: Automatic file compression and optimization
- **Version Control**: Track document versions and changes

### Storage & Security
- **Encrypted Storage**: Enterprise-grade encryption at rest
- **Secure Transfer**: HTTPS encryption for all data transmission
- **Access Controls**: Role-based permissions and access management
- **Audit Trails**: Complete activity logging and audit trails

## 📊 Analytics & Insights

### Processing Analytics
- **Success Rates**: Monitor processing accuracy and success rates
- **Performance Metrics**: Track processing times and throughput
- **Error Analysis**: Identify and analyze processing errors
- **Quality Trends**: Monitor data quality over time

### Financial Analytics
- **Expense Tracking**: Comprehensive expense analysis and reporting
- **Vendor Analysis**: Track spending by vendor and category
- **Tax Reporting**: Automated tax calculation and reporting
- **Budget Monitoring**: Compare actual vs. budgeted expenses

---

These features make SlipScan a comprehensive solution for all your document processing needs.
    `,
    'api-reference': `
# API Reference

Technical documentation for SlipScan's RESTful API.

## 🚀 Getting Started

The SlipScan API provides programmatic access to all platform functionality. Use our API to integrate document processing into your applications.

### Base URL
\`\`\`
https://api.slipscan.com/v1
\`\`\`

### Authentication

All API requests require authentication using API keys:

\`\`\`http
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
\`\`\`

## 📄 Documents API

### Upload Document

Upload a document for processing:

\`\`\`http
POST /documents
Content-Type: multipart/form-data

{
  "file": "binary_file_data",
  "entity_id": "entity_uuid",
  "document_type": "receipt",
  "metadata": {
    "description": "Optional description",
    "tags": ["tag1", "tag2"]
  }
}
\`\`\`

**Response:**
\`\`\`json
{
  "success": true,
  "document_id": "doc_uuid",
  "status": "pending",
  "created_at": "2024-12-01T10:00:00Z"
}
\`\`\`

### Get Document Status

Check processing status:

\`\`\`http
GET /documents/{document_id}
\`\`\`

**Response:**
\`\`\`json
{
  "id": "doc_uuid",
  "status": "completed",
  "extracted_data": {
    "vendor": "Acme Corp",
    "total_amount": 125.50,
    "currency": "USD",
    "date": "2024-12-01"
  },
  "confidence_score": 0.95
}
\`\`\`

### List Documents

Get all documents for an entity:

\`\`\`http
GET /documents?entity_id=entity_uuid&status=completed&limit=50
\`\`\`

## 🏢 Entities API

### Create Entity

\`\`\`http
POST /entities

{
  "name": "My Business",
  "type": "business",
  "settings": {
    "auto_process": true,
    "categories": ["receipts", "invoices"]
  }
}
\`\`\`

### Get Entity

\`\`\`http
GET /entities/{entity_id}
\`\`\`

## 📊 Analytics API

### Get Processing Stats

\`\`\`http
GET /analytics/processing?entity_id=entity_uuid&period=30d
\`\`\`

**Response:**
\`\`\`json
{
  "total_documents": 1250,
  "processed": 1200,
  "failed": 25,
  "pending": 25,
  "average_processing_time": "15.2s",
  "success_rate": 0.96
}
\`\`\`

## 🔔 Webhooks

Configure webhooks to receive real-time notifications:

\`\`\`http
POST /webhooks

{
  "url": "https://yourapi.com/webhook",
  "events": ["document.completed", "document.failed"],
  "entity_id": "entity_uuid"
}
\`\`\`

### Webhook Payload

\`\`\`json
{
  "event": "document.completed",
  "document_id": "doc_uuid",
  "entity_id": "entity_uuid",
  "data": {
    "extracted_data": {...},
    "confidence_score": 0.95
  },
  "timestamp": "2024-12-01T10:05:00Z"
}
\`\`\`

## 📝 Error Handling

The API uses standard HTTP status codes:

- **200**: Success
- **400**: Bad Request
- **401**: Unauthorized
- **404**: Not Found
- **422**: Validation Error
- **500**: Internal Server Error

Error response format:
\`\`\`json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid file format",
    "details": {
      "field": "file",
      "allowed_formats": ["pdf", "jpg", "png"]
    }
  }
}
\`\`\`

## 🔒 Rate Limiting

API requests are rate-limited:

- **Free tier**: 100 requests/hour
- **Pro tier**: 1,000 requests/hour
- **Enterprise**: Custom limits

Rate limit headers:
\`\`\`http
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 995
X-RateLimit-Reset: 1640995200
\`\`\`

---

For more examples and SDKs, visit our [GitHub repository](https://github.com/slipscan/api-examples).
    `,
    'troubleshooting': `
# Troubleshooting Guide

Common issues and solutions for SlipScan users.

## 🔧 Common Issues

### Document Upload Problems

#### File Upload Fails
**Symptoms**: Upload button doesn't respond or shows error

**Solutions**:
1. Check file size (max 10MB)
2. Verify supported format (PDF, JPG, PNG, DOC, DOCX, TXT)
3. Clear browser cache and cookies
4. Try a different browser
5. Check internet connection

#### Processing Stuck in "Pending"
**Symptoms**: Document shows "pending" status for extended time

**Solutions**:
1. Wait 2-3 minutes for normal processing
2. Refresh the page
3. Check system status page
4. Contact support if issue persists

### Poor Processing Results

#### Low Accuracy in Data Extraction
**Symptoms**: AI extracts incorrect or incomplete data

**Solutions**:
1. **Image Quality**: Use high-resolution, clear images
2. **Lighting**: Ensure good lighting and contrast
3. **Orientation**: Make sure document is right-side up
4. **Full Document**: Capture entire document in frame
5. **File Format**: Use PDF for best results when possible

#### Missing Text Recognition
**Symptoms**: Some text not detected by OCR

**Solutions**:
1. Check image resolution (minimum 300 DPI recommended)
2. Ensure text is clearly visible and not blurred
3. Try different image format (PDF often works better)
4. Avoid shadows or glare on document
5. For handwritten text, ensure clear penmanship

### Account and Authentication Issues

#### Can't Sign In
**Symptoms**: Login fails with correct credentials

**Solutions**:
1. Check email and password carefully
2. Try password reset if forgotten
3. Clear browser cache and cookies
4. Disable browser password managers temporarily
5. Try incognito/private browsing mode

#### Two-Factor Authentication Problems
**Symptoms**: 2FA code not working

**Solutions**:
1. Check time sync on your device
2. Generate new code from authenticator app
3. Use backup codes if available
4. Contact support to reset 2FA

### Entity and Team Management

#### Can't Create Entity
**Symptoms**: Entity creation fails or times out

**Solutions**:
1. Check all required fields are filled
2. Ensure entity name is unique
3. Try refreshing page and starting over
4. Check account permissions

#### Team Member Invitation Issues
**Symptoms**: Team invitations not received

**Solutions**:
1. Check spam/junk folders
2. Verify email address is correct
3. Resend invitation
4. Ask invitee to check email filters
5. Try different email address

## 🚨 Error Messages

### "Processing Failed"
**Cause**: Document couldn't be processed by AI

**Solutions**:
1. Check file isn't corrupted
2. Try re-uploading the document
3. Use different file format
4. Ensure document contains readable text
5. Contact support with document details

### "Entity Not Found"
**Cause**: Selected entity doesn't exist or access denied

**Solutions**:
1. Refresh page to reload entities
2. Check if entity was deleted
3. Verify you have access permissions
4. Contact entity owner if you should have access

### "File Too Large"
**Cause**: Document exceeds 10MB limit

**Solutions**:
1. Compress the file using online tools
2. Convert to more efficient format (PDF)
3. Split large documents into smaller parts
4. Remove unnecessary pages

## 📱 Browser and Device Issues

### Mobile Upload Problems
**Symptoms**: Can't upload from mobile device

**Solutions**:
1. Use supported mobile browsers (Chrome, Safari, Firefox)
2. Enable camera permissions for photo uploads
3. Clear mobile browser cache
4. Try desktop version if mobile fails

### Performance Issues
**Symptoms**: Slow loading or unresponsive interface

**Solutions**:
1. Close other browser tabs
2. Clear browser cache
3. Disable browser extensions temporarily
4. Check internet speed
5. Try different browser

## 🔍 API and Integration Issues

### API Authentication Errors
**Symptoms**: 401 Unauthorized responses

**Solutions**:
1. Verify API key is correct
2. Check API key hasn't expired
3. Ensure proper Authorization header format
4. Regenerate API key if needed

### Webhook Not Receiving Events
**Symptoms**: Webhook endpoint not getting notifications

**Solutions**:
1. Verify webhook URL is accessible
2. Check webhook configuration
3. Ensure endpoint accepts POST requests
4. Check firewall settings
5. Test webhook with external tools

## 💡 Performance Optimization

### Improve Processing Speed
1. **Use PDF format** when possible for faster processing
2. **Optimize image size** - balance quality and file size
3. **Process during off-peak hours** for faster response
4. **Use batch upload** for multiple documents

### Improve Accuracy
1. **Scan at 300 DPI** or higher resolution
2. **Use black text on white background** when possible
3. **Ensure documents are flat** without folds or creases
4. **Remove staples and clips** before scanning

## 📞 Getting Additional Help

### Before Contacting Support

1. Check this troubleshooting guide
2. Review the [FAQ](faq) section
3. Check system status page
4. Try the solution with a different document

### When Contacting Support

Include the following information:
- Document ID (if applicable)
- Browser and version
- Steps to reproduce the issue
- Error messages received
- Screenshots of the problem

### Support Channels

- **Email**: support@slipscan.com
- **Documentation**: This help center
- **Status Page**: status.slipscan.com

---

Most issues can be resolved quickly with these solutions. For persistent problems, our support team is here to help!
    `,
    'faq': `
# Frequently Asked Questions

Quick answers to common questions about SlipScan.

## 🚀 Getting Started

### What is SlipScan?
SlipScan is an AI-powered document processing platform that automatically extracts, analyzes, and organizes data from various document types including receipts, invoices, contracts, and more.

### How do I get started?
1. Sign up for a free account
2. Create your first entity (business/organization)
3. Upload a document to see AI processing in action
4. Review extracted data and explore features

### Is there a free plan?
Yes! Our free plan includes:
- Up to 50 documents per month
- Basic AI processing
- 1 entity
- Email support

## 📄 Document Processing

### What file types are supported?
We support:
- **Images**: JPG, JPEG, PNG, GIF
- **Documents**: PDF, DOC, DOCX, TXT
- **Maximum size**: 10MB per file

### How accurate is the AI processing?
Our AI typically achieves 90-95% accuracy on clear, well-formatted documents. Accuracy depends on:
- Document quality and resolution
- Text clarity and formatting
- Document type and complexity

### How long does processing take?
- **Simple documents**: 10-30 seconds
- **Complex documents**: 1-3 minutes
- **Large batches**: Process in parallel for efficiency

### Can I process handwritten documents?
Yes, but with limitations:
- Clear handwriting works better
- Printed text generally more accurate
- Some handwritten elements may require manual review

## 🏢 Entities and Teams

### What is an entity?
An entity represents a business, department, or organization. Each entity has:
- Separate document storage
- Independent team management
- Isolated analytics and reporting
- Custom processing settings

### How many entities can I have?
- **Free plan**: 1 entity
- **Pro plan**: Up to 5 entities
- **Enterprise**: Unlimited entities

### Can I invite team members?
Yes! You can invite team members with different roles:
- **Owner**: Full access and control
- **Manager**: Can manage documents and invite members
- **Member**: Can upload and view documents
- **Viewer**: Read-only access

### How does billing work with multiple entities?
Document processing is counted across all entities in your account. Team members don't count toward document limits.

## 🔐 Security and Privacy

### Is my data secure?
Absolutely. We implement enterprise-grade security:
- **Encryption**: All data encrypted at rest and in transit
- **Access controls**: Role-based permissions
- **Compliance**: SOC 2 Type II certified
- **Backup**: Regular automated backups

### Where is my data stored?
Data is stored in secure cloud infrastructure with multiple geographic redundancy for reliability and performance.

### Who can access my documents?
Only you and team members you explicitly invite can access your documents. SlipScan staff may access data only for support purposes with your permission.

### Can I delete my data?
Yes, you have complete control:
- Delete individual documents anytime
- Export all data before deletion
- Account deletion removes all associated data
- GDPR compliant data handling

## 💰 Pricing and Plans

### How much does SlipScan cost?
- **Free**: $0/month - 50 documents
- **Pro**: $29/month - 1,000 documents
- **Enterprise**: Custom pricing - Unlimited documents

### What happens if I exceed my document limit?
- Processing stops until next billing cycle
- Option to upgrade plan immediately
- No documents are deleted or lost

### Can I cancel anytime?
Yes, you can cancel your subscription anytime. You'll continue to have access until the end of your billing period.

### Do you offer refunds?
We offer prorated refunds for annual plans if you cancel within 30 days.

## 🔧 Technical Questions

### Do you have an API?
Yes! We provide a comprehensive RESTful API for:
- Document upload and processing
- Data retrieval and export
- Webhook notifications
- Account management

### Can I integrate with other software?
Yes, we offer integrations with:
- Accounting software (QuickBooks, Xero)
- Cloud storage (Google Drive, Dropbox)
- ERP systems (SAP, Oracle)
- Custom integrations via API

### What about mobile access?
SlipScan works on all devices:
- Responsive web interface
- Mobile-optimized upload
- Progressive web app capabilities
- Camera integration for mobile uploads

### Do you support multiple languages?
Yes, our OCR supports 50+ languages including:
- English, Spanish, French, German
- Chinese, Japanese, Korean
- Arabic, Russian, Portuguese
- And many more

## 📊 Data and Analytics

### What data is extracted from documents?
Common extracted data includes:
- **Financial**: Amounts, taxes, totals, currencies
- **Dates**: Transaction dates, due dates
- **Vendors**: Names, addresses, contact info
- **Line items**: Product descriptions, quantities
- **Custom fields**: Based on document type

### Can I export my data?
Yes, export options include:
- CSV for spreadsheets
- JSON for developers
- PDF reports
- Excel format with formatting

### How long is data retained?
- **Active accounts**: Data retained indefinitely
- **Cancelled accounts**: 90 days before deletion
- **Custom retention**: Available for Enterprise plans

## 🛠️ Troubleshooting

### My document processing failed. Why?
Common causes:
- Poor image quality or resolution
- Unsupported file format
- File size too large (>10MB)
- Document doesn't contain readable text

### I can't find extracted data. Where is it?
Check:
- Document processing status (may still be processing)
- Confidence threshold settings
- Document type classification
- Manual review queue for low-confidence items

### The mobile upload isn't working. What should I do?
Try:
- Enable camera permissions
- Use supported browsers (Chrome, Safari, Firefox)
- Clear browser cache
- Try desktop version if mobile fails

## 📞 Support

### How can I get help?
- **Documentation**: Comprehensive guides and tutorials
- **Email support**: support@slipscan.com
- **Response times**: 24 hours for all plans
- **Priority support**: Available for Enterprise plans

### Do you offer training or onboarding?
- **Self-service**: Complete documentation and tutorials
- **Email support**: For specific questions
- **Custom training**: Available for Enterprise customers
- **Video guides**: Coming soon

---

Can't find your answer? Contact our support team at support@slipscan.com
    `,
    'setup': `
# Setup & Installation Guide

Complete setup guide for SlipScan document processing platform.

## 🚀 Quick Setup

### 1. Account Creation

1. **Visit SlipScan**: Go to [app.slipscan.com](https://app.slipscan.com)
2. **Sign Up**: Click "Sign Up" and fill in your details
3. **Verify Email**: Check your email and click verification link
4. **Complete Profile**: Add your name and profile information

### 2. Create Your First Entity

An entity represents your business or organization:

1. Click "Create Entity" from your dashboard
2. Fill in entity details:
   - **Name**: Your business name
   - **Type**: Business, department, or organization
   - **Address**: Business address (optional)
   - **Contact**: Phone and email (optional)

### 3. Configure Processing Settings

Set up how documents should be processed:

1. Go to Entity Settings
2. Configure default categories:
   - Receipts
   - Invoices
   - Contracts
   - Tax Documents
   - Custom categories

3. Set processing preferences:
   - Auto-processing enabled/disabled
   - Confidence thresholds
   - Notification settings

## 🔧 Advanced Configuration

### Team Setup

#### Invite Team Members

1. Navigate to Entity Settings → Team Management
2. Click "Invite Member"
3. Enter email addresses
4. Assign roles:
   - **Owner**: Full access
   - **Manager**: Can manage documents and team
   - **Member**: Can upload and view documents
   - **Viewer**: Read-only access

#### Configure Permissions

Set granular permissions for team members:
- Document upload permissions
- Data export capabilities
- Analytics access levels
- Administrative functions

### Processing Optimization

#### Quality Settings

Configure processing quality vs. speed:

1. **High Quality Mode**: Slower but more accurate
2. **Fast Mode**: Quick processing for simple documents
3. **Balanced Mode**: Good balance of speed and accuracy

#### Confidence Thresholds

Set confidence levels for automatic processing:
- **High Confidence**: 90%+ - Auto-approve
- **Medium Confidence**: 70-90% - Flag for review
- **Low Confidence**: <70% - Require manual review

### Integration Setup

#### API Configuration

1. Generate API keys:
   - Go to Account Settings → API Keys
   - Click "Generate New Key"
   - Copy and securely store the key

2. Configure webhooks:
   - Set webhook URLs for real-time notifications
   - Choose events to monitor
   - Test webhook endpoints

#### Third-Party Integrations

##### QuickBooks Integration
1. Connect your QuickBooks account
2. Map document categories to QuickBooks accounts
3. Set up automatic transaction creation

##### Google Drive Sync
1. Authorize Google Drive access
2. Choose sync folders
3. Configure automatic upload rules

## 📱 Mobile Setup

### Progressive Web App

Install SlipScan as a mobile app:

1. **iOS Safari**:
   - Visit app.slipscan.com
   - Tap Share button
   - Select "Add to Home Screen"

2. **Android Chrome**:
   - Visit app.slipscan.com
   - Tap menu (three dots)
   - Select "Add to Home Screen"

### Camera Permissions

Enable camera access for document capture:
1. Allow camera permissions when prompted
2. Grant photo library access for uploads
3. Enable notifications for processing updates

## 🔐 Security Setup

### Two-Factor Authentication

Enable 2FA for enhanced security:

1. Go to Account Settings → Security
2. Click "Enable Two-Factor Authentication"
3. Scan QR code with authenticator app
4. Enter verification code
5. Save backup codes securely

### Password Policy

Follow our recommended password guidelines:
- Minimum 12 characters
- Mix of uppercase, lowercase, numbers, symbols
- Unique password not used elsewhere
- Consider using a password manager

### Session Management

Configure session preferences:
- Auto-logout after inactivity
- Concurrent session limits
- Device management and remote logout

## 📊 Analytics Setup

### Dashboard Customization

Customize your dashboard widgets:
1. Drag and drop widgets to reorder
2. Show/hide specific metrics
3. Set time ranges for analytics
4. Configure refresh intervals

### Report Configuration

Set up automated reports:
1. Choose report types and frequency
2. Select recipients for email reports
3. Configure export formats
4. Schedule delivery times

## 🔄 Data Migration

### Importing Existing Documents

Bulk upload existing documents:

1. **Prepare Files**:
   - Organize in folders by category
   - Ensure files meet size requirements (<10MB)
   - Use supported formats (PDF, JPG, PNG, etc.)

2. **Batch Upload**:
   - Select multiple files
   - Choose appropriate categories
   - Monitor processing progress

3. **Data Mapping**:
   - Review extracted data
   - Correct any inaccuracies
   - Set up validation rules

### Export from Other Systems

Import data from existing systems:
- Export from accounting software
- Convert proprietary formats
- Clean and organize data
- Map to SlipScan categories

## 🧪 Testing and Validation

### Test Document Processing

Before full deployment:

1. **Test Different Document Types**:
   - Upload sample receipts
   - Test invoice processing
   - Try contract analysis

2. **Verify Accuracy**:
   - Review extracted data
   - Check confidence scores
   - Test correction workflows

3. **Performance Testing**:
   - Upload batch documents
   - Monitor processing times
   - Test during peak hours

### User Acceptance Testing

Have team members test the system:
1. Create test accounts
2. Process sample documents
3. Verify workflow integration
4. Gather feedback and adjust

## 🚦 Go-Live Checklist

Before full deployment:

- [ ] Account and entity setup complete
- [ ] Team members invited and trained
- [ ] Processing settings configured
- [ ] Security measures enabled
- [ ] Integrations tested and working
- [ ] Test documents processed successfully
- [ ] Backup and recovery procedures in place
- [ ] Support contacts and procedures documented

## 📞 Support Resources

### Getting Help During Setup

- **Documentation**: Complete setup guides
- **Email Support**: setup@slipscan.com
- **Video Tutorials**: Step-by-step guides
- **Live Chat**: Available during business hours

### Ongoing Support

- **Knowledge Base**: Searchable help articles
- **Community Forum**: User discussions
- **Product Updates**: Feature announcements
- **Training Resources**: Advanced usage guides

---

Need help with setup? Contact our support team at setup@slipscan.com
    `
  };

  // Load content based on current section
  useEffect(() => {
    setLoading(true);
    const sectionContent = contentMap[currentSection] || contentMap['overview'];
    setContent(sectionContent);
    setActiveNav(currentSection);
    setLoading(false);
  }, [currentSection]);

  // Handle navigation
  const handleNavClick = (sectionId) => {
    setCurrentSection(sectionId);
    navigate(`/docs/${sectionId}`);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <h1 className="text-xl font-bold text-gray-900">SlipScan Docs</h1>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <a 
                href="/" 
                className="text-gray-600 hover:text-gray-900 transition-colors"
              >
                ← Back to App
              </a>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex gap-8">
          {/* Main Content */}
          <main className="flex-1 max-w-none">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="p-8">
                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                  </div>
                ) : (
                  <div className="prose prose-lg max-w-none">
                    <div className="markdown-content">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {content}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </main>

          {/* Right Navigation */}
          <aside className="w-80 flex-shrink-0">
            <div className="sticky top-24">
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <div className="p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">Documentation</h3>
                  <nav className="space-y-6">
                    {navigation.map((section) => (
                      <div key={section.title}>
                        <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wider mb-3">
                          {section.title}
                        </h4>
                        <ul className="space-y-2">
                          {section.items.map((item) => {
                            const Icon = item.icon;
                            const isActive = activeNav === item.id;
                            return (
                              <li key={item.id}>
                                <button
                                  onClick={() => handleNavClick(item.id)}
                                  className={`w-full flex items-center px-3 py-2 text-sm rounded-md transition-colors ${
                                    isActive
                                      ? 'bg-blue-50 text-blue-700 font-medium'
                                      : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                                  }`}
                                >
                                  <Icon className={`w-4 h-4 mr-3 ${
                                    isActive ? 'text-blue-500' : 'text-gray-400'
                                  }`} />
                                  {item.title}
                                  {isActive && (
                                    <ChevronRight className="w-4 h-4 ml-auto text-blue-500" />
                                  )}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </nav>
                </div>
              </div>

              {/* Quick Links */}
              <div className="mt-6 bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <div className="p-6">
                  <h4 className="text-sm font-medium text-gray-900 mb-4">Quick Links</h4>
                  <div className="space-y-3">
                    <a 
                      href="/dashboard" 
                      className="flex items-center text-sm text-blue-600 hover:text-blue-800 transition-colors"
                    >
                      <Home className="w-4 h-4 mr-2" />
                      Go to Dashboard
                    </a>
                    <a 
                      href="/documents" 
                      className="flex items-center text-sm text-blue-600 hover:text-blue-800 transition-colors"
                    >
                      <FileText className="w-4 h-4 mr-2" />
                      Upload Documents
                    </a>
                    <a 
                      href="/settings" 
                      className="flex items-center text-sm text-blue-600 hover:text-blue-800 transition-colors"
                    >
                      <Settings className="w-4 h-4 mr-2" />
                      Account Settings
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* Custom styles for markdown content */}
      <style jsx global>{`
        .markdown-content h1 {
          font-size: 2.25rem;
          font-weight: 700;
          margin-bottom: 1rem;
          color: #111827;
        }
        .markdown-content h2 {
          font-size: 1.875rem;
          font-weight: 600;
          margin-top: 2rem;
          margin-bottom: 1rem;
          color: #374151;
        }
        .markdown-content h3 {
          font-size: 1.5rem;
          font-weight: 600;
          margin-top: 1.5rem;
          margin-bottom: 0.75rem;
          color: #4B5563;
        }
        .markdown-content h4 {
          font-size: 1.25rem;
          font-weight: 600;
          margin-top: 1.25rem;
          margin-bottom: 0.5rem;
          color: #6B7280;
        }
        .markdown-content p {
          margin-bottom: 1rem;
          line-height: 1.75;
          color: #374151;
        }
        .markdown-content ul, .markdown-content ol {
          margin-bottom: 1rem;
          padding-left: 1.5rem;
        }
        .markdown-content li {
          margin-bottom: 0.5rem;
          color: #374151;
        }
        .markdown-content pre {
          background-color: #F3F4F6;
          border-radius: 0.5rem;
          padding: 1rem;
          overflow-x: auto;
          margin-bottom: 1rem;
        }
        .markdown-content code {
          background-color: #F3F4F6;
          padding: 0.125rem 0.25rem;
          border-radius: 0.25rem;
          font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
          font-size: 0.875rem;
        }
        .markdown-content pre code {
          background-color: transparent;
          padding: 0;
        }
        .markdown-content blockquote {
          border-left: 4px solid #E5E7EB;
          padding-left: 1rem;
          margin-left: 0;
          margin-bottom: 1rem;
          font-style: italic;
          color: #6B7280;
        }
        .markdown-content strong {
          font-weight: 600;
          color: #111827;
        }
        .markdown-content a {
          color: #2563EB;
          text-decoration: underline;
        }
        .markdown-content a:hover {
          color: #1D4ED8;
        }
        .markdown-content hr {
          border: 0;
          border-top: 1px solid #E5E7EB;
          margin: 2rem 0;
        }
      `}</style>
    </div>
  );
};

export default DocsPage; 