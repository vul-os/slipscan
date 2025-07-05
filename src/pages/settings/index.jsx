import React, { useState, useEffect } from 'react';
import { useAuth } from '@/context/auth-context';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { 
  Settings, 
  Building, 
  Mail, 
  Save, 
  Copy, 
  Check,
  User,
  Shield
} from 'lucide-react';


const SettingsPage = () => {
  const { user, activeEntity, entities, updateEntity } = useAuth();
  const [entityName, setEntityName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (activeEntity) {
      setEntityName(activeEntity.name || '');
    }
  }, [activeEntity]);

  const handleUpdateEntityName = async () => {
    if (!activeEntity || !entityName.trim()) return;
    
    setIsLoading(true);
    try {
      await updateEntity(activeEntity.id, { name: entityName.trim() });
    } catch (error) {
      console.error('Error updating entity:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  const documentEmail = activeEntity ? `${activeEntity.id}@docs.slipscan.com` : '';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-gradient-to-r from-purple-500 to-blue-500 rounded-xl flex items-center justify-center">
          <Settings className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-gray-600">Manage your account and entity preferences</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Settings */}
        <div className="lg:col-span-2 space-y-6">
          {/* Entity Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building className="w-5 h-5 text-purple-600" />
                Entity Settings
              </CardTitle>
              <CardDescription>
                Configure your entity details and preferences
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Entity Name */}
              <div className="space-y-2">
                <Label htmlFor="entity-name">Entity Name</Label>
                <div className="flex gap-2">
                  <Input
                    id="entity-name"
                    value={entityName}
                    onChange={(e) => setEntityName(e.target.value)}
                    placeholder="Enter entity name..."
                    className="flex-1"
                  />
                  <Button
                    onClick={handleUpdateEntityName}
                    disabled={isLoading || !entityName.trim() || entityName === activeEntity?.name}
                    className="bg-purple-600 hover:bg-purple-700"
                  >
                    {isLoading ? (
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                    Save
                  </Button>
                </div>
                <p className="text-sm text-gray-500">
                  This name will be displayed across your dashboard and reports
                </p>
              </div>

              <Separator />

              {/* Document Email */}
              <div className="space-y-2">
                <Label>Document Email Address</Label>
                <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg border">
                  <Mail className="w-4 h-4 text-gray-500" />
                  <code className="flex-1 text-sm font-mono text-gray-900">
                    {documentEmail || 'No entity selected'}
                  </code>
                  {documentEmail && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(documentEmail)}
                      className="h-8 px-3"
                    >
                      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </Button>
                  )}
                </div>
                <p className="text-sm text-gray-500">
                  Forward or email documents to this address for AI processing. 
                  Documents will be automatically processed and categorized.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Account Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="w-5 h-5 text-blue-600" />
                Account Settings
              </CardTitle>
              <CardDescription>
                Your account information and preferences
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium text-gray-700">Email Address</Label>
                  <p className="text-sm text-gray-600">{user?.email}</p>
                </div>
                <Badge variant="outline" className="text-green-600 border-green-200">
                  <Shield className="w-3 h-3 mr-1" />
                  Verified
                </Badge>
              </div>
              
              <div>
                <Label className="text-sm font-medium text-gray-700">Account Type</Label>
                <p className="text-sm text-gray-600">Standard Account</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Quick Stats */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Quick Stats</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">Active Entities</span>
                <Badge variant="secondary">{entities?.length || 0}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-600">Current Entity</span>
                <Badge className="bg-purple-100 text-purple-800">
                  {activeEntity?.name || 'None'}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* Help Section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Need Help?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-gray-600">
                Have questions about document processing or entity management?
              </p>
              <div className="space-y-2">
                <Button variant="outline" className="w-full justify-start text-sm">
                  <Mail className="w-4 h-4 mr-2" />
                  Contact Support
                </Button>
                <Button variant="outline" className="w-full justify-start text-sm">
                  <Settings className="w-4 h-4 mr-2" />
                  View Documentation
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
