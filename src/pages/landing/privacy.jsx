import React from 'react';
import { Shield, Eye, Lock, Users, Database, Bell, Trash2, FileText } from 'lucide-react';

const PrivacyPolicy = React.forwardRef((props, ref) => {
  return (
    <section ref={ref} className="py-16 bg-gray-50">
      <div className="container mx-auto px-4">
        <h1 className="text-4xl font-bold text-center mb-12 text-gray-800">SlipSnap Privacy Policy</h1>
        
        <div className="max-w-4xl mx-auto space-y-12">
          <div>
            <h2 className="text-2xl font-semibold mb-4 text-gray-800 flex items-center">
              <Eye className="mr-2" /> 1. Information We Collect
            </h2>
            <p className="text-gray-600 mb-4">At SlipSnap, we collect the following types of information:</p>
            <ul className="list-disc pl-6 text-gray-600 space-y-2">
              <li>Receipt images and associated data</li>
              <li>Account information (e.g., name, email address)</li>
              <li>Usage data (e.g., features used, time spent on the app)</li>
              <li>Device information (e.g., device type, operating system)</li>
            </ul>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-4 text-gray-800 flex items-center">
              <Lock className="mr-2" /> 2. How We Use Your Information
            </h2>
            <p className="text-gray-600 mb-4">We use your information to:</p>
            <ul className="list-disc pl-6 text-gray-600 space-y-2">
              <li>Process and analyze your receipts</li>
              <li>Provide and improve our services</li>
              <li>Communicate with you about your account and our services</li>
              <li>Detect and prevent fraud or misuse of our services</li>
            </ul>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-4 text-gray-800 flex items-center">
              <Database className="mr-2" /> 3. Data Storage and Security
            </h2>
            <p className="text-gray-600 mb-4">
              Your receipt images are stored securely and are viewable only by you and our authorized personnel for processing purposes. While not encrypted at rest, they are protected by strict access controls and modern security measures, including:
            </p>
            <ul className="list-disc pl-6 text-gray-600 space-y-2">
              <li>Row-level security powered by Supabase</li>
              <li>Regular security audits and updates</li>
              <li>Secure data transmission using encryption</li>
            </ul>
            <p className="text-gray-600 mt-4">
              This approach balances security and functionality, allowing us to process your receipts efficiently while maintaining strong protections.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-4 text-gray-800 flex items-center">
              <Users className="mr-2" /> 4. Data Sharing
            </h2>
            <p className="text-gray-600 mb-4">
              Currently, we do not share your data with third parties. However, as our service evolves, we may need to share data in the future. If this becomes necessary, we will:
            </p>
            <ul className="list-disc pl-6 text-gray-600 space-y-2">
              <li>Notify you of any changes to our data sharing practices</li>
              <li>Provide you with the opportunity to consent or opt-out, where applicable</li>
              <li>Only share data necessary for the provision or improvement of our services</li>
            </ul>
            <p className="text-gray-600 mt-4">
              By using our service, you acknowledge that data sharing practices may change, and you consent to such potential future sharing, subject to the notifications and options we will provide.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-4 text-gray-800 flex items-center">
              <Shield className="mr-2" /> 5. Your Rights and Choices
            </h2>
            <p className="text-gray-600 mb-4">You have the right to:</p>
            <ul className="list-disc pl-6 text-gray-600 space-y-2">
              <li>Access and review your personal information</li>
              <li>Request corrections to your personal information</li>
              <li>Delete your account and associated data</li>
              <li>Opt-out of certain data collection or use</li>
            </ul>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-4 text-gray-800 flex items-center">
              <Bell className="mr-2" /> 6. Changes to This Policy
            </h2>
            <p className="text-gray-600">
              We may update this privacy policy from time to time. We will notify you of any significant changes by posting a notice on our website or sending you an email.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-4 text-gray-800 flex items-center">
              <Trash2 className="mr-2" /> 7. Data Retention and Deletion
            </h2>
            <p className="text-gray-600">
              We retain your data for as long as your account is active or as needed to provide you services. If you delete your account, we will delete or anonymize your data within 30 days, unless we are legally required to retain it.
            </p>
          </div>

          <div>
            <h2 className="text-2xl font-semibold mb-4 text-gray-800 flex items-center">
              <FileText className="mr-2" /> 8. Contact Us
            </h2>
            <p className="text-gray-600">
              If you have any questions about this privacy policy or our data practices, please contact us at exolutionza@gmail.com
            </p>
          </div>

          <p className="text-sm text-gray-500 mt-8">
            Last updated: 06 Oct 2024
          </p>
        </div>
      </div>
    </section>
  );
});

export default PrivacyPolicy;