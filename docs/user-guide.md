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

### Switching Between Entities

Use the entity selector in the top navigation to switch between different entities you have access to.

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

### Document Types

SlipScan can process various document types:

#### Receipts
- Vendor information
- Purchase date and time
- Item details and quantities
- Tax amounts
- Total amount

#### Invoices
- Billing information
- Invoice number and date
- Line items and descriptions
- Subtotals and taxes
- Payment terms

#### Contracts
- Party information
- Contract terms
- Important dates
- Key clauses
- Signatures

#### Financial Documents
- Account information
- Transaction details
- Balances and totals
- Date ranges

### Data Extraction

AI automatically extracts:
- **Text Content**: All readable text
- **Structured Data**: Tables, forms, fields
- **Financial Information**: Amounts, taxes, totals
- **Dates and Numbers**: Formatted and standardized
- **Vendor/Customer Info**: Names, addresses, contacts

## 📊 Data Analysis

### Viewing Extracted Data

For each processed document:
1. Click on document in the list
2. View extracted data in structured format
3. See confidence scores for AI predictions
4. Edit or correct any inaccuracies

### Search and Filter

#### Search Options
- **Text Search**: Search within document content
- **Vendor Search**: Find documents by vendor name
- **Amount Range**: Filter by monetary amounts
- **Date Range**: Filter by document or upload dates

#### Filter Options
- **Processing Status**: Filter by processing stage
- **Document Type**: Filter by category
- **Entity**: Filter by specific entity
- **Tags**: Filter by custom tags

### Export Options

Export processed data in various formats:
- **CSV**: Spreadsheet-compatible format
- **PDF**: Formatted reports
- **JSON**: API-compatible format
- **Excel**: Advanced spreadsheet format

## 👥 Team Collaboration

### Inviting Team Members

1. Go to Entity Settings
2. Click "Team Management"
3. Click "Invite Member"
4. Enter email address
5. Select role and permissions
6. Send invitation

### User Roles

#### Owner
- Full access to entity
- Can manage all settings
- Can invite/remove team members
- Can delete entity

#### Manager
- Can upload and manage documents
- Can view all analytics
- Can invite team members
- Cannot delete entity

#### Member
- Can upload documents
- Can view assigned documents
- Limited analytics access
- Cannot manage team

#### Viewer
- Read-only access
- Can view documents and data
- Cannot upload or modify
- Cannot access settings

### Collaboration Features

- **Shared Workspaces**: Team access to entity documents
- **Comments**: Add notes and comments to documents
- **Activity Logs**: Track team member actions
- **Notifications**: Stay updated on team activities

## ⚙️ Settings & Configuration

### Account Settings

#### Profile
- Update personal information
- Change password
- Set notification preferences
- Manage API keys

#### Security
- Two-factor authentication
- Login activity monitoring
- Device management
- Session controls

### Entity Settings

#### Processing Preferences
- Default document categories
- Auto-processing rules
- Quality thresholds
- Retry policies

#### Integrations
- Connect external tools
- Set up webhooks
- Configure API access
- Sync with accounting software

#### Data Retention
- Set retention periods
- Configure backup options
- Manage data lifecycle
- Export archives

## 🔍 Advanced Features

### API Access

SlipScan provides RESTful APIs for:
- Document upload and processing
- Data retrieval and export
- Webhook notifications
- Status monitoring

### Automation Rules

Set up rules to automatically:
- Categorize documents by content
- Route documents to team members
- Trigger external workflows
- Send notifications

### Custom Categories

Create custom document categories:
1. Go to Entity Settings
2. Click "Document Categories"
3. Click "Add Category"
4. Define category name and rules
5. Set up automatic classification

## 📈 Analytics & Reporting

### Document Analytics
- Processing success rates
- Average processing times
- Document volume trends
- Error rate analysis

### Financial Analytics
- Expense tracking by category
- Vendor spending analysis
- Tax amount summaries
- Monthly/quarterly reports

### Team Analytics
- User activity metrics
- Upload frequency
- Processing efficiency
- Collaboration statistics

## 🛠️ Troubleshooting

### Common Issues

#### Poor Processing Results
- Check image quality
- Ensure proper document orientation
- Verify file format compatibility
- Review lighting and contrast

#### Failed Uploads
- Check file size limits (10MB max)
- Verify supported file formats
- Check internet connection
- Clear browser cache

#### Missing Data
- Review confidence thresholds
- Check document quality
- Verify extraction rules
- Contact support for assistance

### Getting Help

- Check [FAQ](./faq.md) for quick answers
- Review [Troubleshooting](./troubleshooting.md) guide
- Contact support team
- Access community forums

---

This user guide covers all major features of SlipScan. For technical details, see the [API Reference](./api-reference.md). 