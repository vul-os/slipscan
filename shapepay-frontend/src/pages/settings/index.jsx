import React, { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Profile from './profile';
import Merchant from './merchant';
import { Home, User, Building2 } from 'lucide-react';
import { Link } from 'react-router-dom';

const SettingsPage = () => {
  const [activeTab, setActiveTab] = useState("profile");

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <div className="container mx-auto p-4">
        <div className="flex items-center space-x-2 mb-4">
          <Link to="/" className="text-blue-400 hover:text-blue-300 flex items-center">
            <Home className="w-4 h-4 mr-1" />
            Home
          </Link>
          <span>/</span>
          <span className="flex items-center">
            Settings
          </span>
        </div>

        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-100">Settings</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="profile" className="flex items-center">
                  <User className="w-4 h-4 mr-2" />
                  Profile
                </TabsTrigger>
                <TabsTrigger value="merchant" className="flex items-center">
                  <Building2 className="w-4 h-4 mr-2" />
                  Merchant
                </TabsTrigger>
              </TabsList>
              <TabsContent value="profile">
                <Profile />
              </TabsContent>
              <TabsContent value="merchant">
                <Merchant />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default SettingsPage;