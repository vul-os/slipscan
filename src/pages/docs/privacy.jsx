import React from 'react';

const PrivacyPolicy = () => {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <h1 className="text-xl font-bold text-gray-900">SlipScan Privacy Policy</h1>
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

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-8">
            <div className="prose prose-lg max-w-none">
              <h1>Privacy Policy</h1>
              <p className="text-gray-600"><strong>Last updated:</strong> December 2024</p>

              <h2>1. Information We Collect</h2>
              <p>We collect information you provide directly to us, such as when you create an account, upload documents, or contact us for support.</p>

              <h3>Personal Information</h3>
              <ul>
                <li>Name and email address</li>
                <li>Account credentials</li>
                <li>Business information for entities</li>
                <li>Communication preferences</li>
              </ul>

              <h3>Document Data</h3>
              <ul>
                <li>Uploaded documents and files</li>
                <li>Extracted data from document processing</li>
                <li>Processing metadata and timestamps</li>
                <li>User annotations and corrections</li>
              </ul>

              <h3>Usage Information</h3>
              <ul>
                <li>How you interact with our service</li>
                <li>Features you use and frequency</li>
                <li>Error logs and performance data</li>
                <li>Device and browser information</li>
              </ul>

              <h2>2. How We Use Your Information</h2>
              <p>We use the information we collect to:</p>
              <ul>
                <li>Provide, maintain, and improve our services</li>
                <li>Process and analyze your documents using AI</li>
                <li>Communicate with you about your account and our services</li>
                <li>Provide customer support</li>
                <li>Ensure security and prevent fraud</li>
                <li>Comply with legal obligations</li>
              </ul>

              <h2>3. Information Sharing</h2>
              <p>We do not sell, trade, or rent your personal information to third parties. We may share information in the following circumstances:</p>

              <h3>With Your Consent</h3>
              <p>We may share information when you explicitly consent to such sharing.</p>

              <h3>Service Providers</h3>
              <p>We work with third-party service providers who assist us in operating our platform. These providers are bound by confidentiality agreements.</p>

              <h3>Legal Requirements</h3>
              <p>We may disclose information if required by law, regulation, or legal process.</p>

              <h3>Business Transfers</h3>
              <p>Information may be transferred in connection with a merger, acquisition, or sale of assets.</p>

              <h2>4. Data Security</h2>
              <p>We implement appropriate technical and organizational measures to protect your information:</p>
              <ul>
                <li>Encryption of data in transit and at rest</li>
                <li>Regular security assessments and updates</li>
                <li>Access controls and authentication</li>
                <li>Employee training on data protection</li>
                <li>Incident response procedures</li>
              </ul>

              <h2>5. Data Retention</h2>
              <p>We retain your information for as long as necessary to provide our services and comply with legal obligations:</p>
              <ul>
                <li><strong>Account Data:</strong> Until account deletion</li>
                <li><strong>Document Data:</strong> Until you delete documents or close your account</li>
                <li><strong>Usage Data:</strong> Up to 2 years for analytics purposes</li>
                <li><strong>Legal Compliance:</strong> As required by applicable laws</li>
              </ul>

              <h2>6. Your Rights</h2>
              <p>Depending on your location, you may have the following rights:</p>
              <ul>
                <li><strong>Access:</strong> Request access to your personal information</li>
                <li><strong>Correction:</strong> Request correction of inaccurate information</li>
                <li><strong>Deletion:</strong> Request deletion of your information</li>
                <li><strong>Portability:</strong> Request a copy of your data in a portable format</li>
                <li><strong>Restriction:</strong> Request restriction of processing</li>
                <li><strong>Objection:</strong> Object to certain types of processing</li>
              </ul>

              <h2>7. International Data Transfers</h2>
              <p>Your information may be processed in countries other than your own. We ensure appropriate safeguards are in place for international transfers.</p>

              <h2>8. Children's Privacy</h2>
              <p>Our service is not intended for children under 13. We do not knowingly collect personal information from children under 13.</p>

              <h2>9. Changes to This Policy</h2>
              <p>We may update this privacy policy from time to time. We will notify you of material changes by posting the updated policy on our website.</p>

              <h2>10. Contact Us</h2>
              <p>If you have questions about this privacy policy, please contact us:</p>
              <ul>
                <li><strong>Email:</strong> privacy@slipscan.com</li>
                <li><strong>Address:</strong> [Company Address]</li>
              </ul>

              <hr />
              <p className="text-sm text-gray-600">
                This privacy policy is effective as of the date listed above and replaces any prior privacy policy.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PrivacyPolicy; 