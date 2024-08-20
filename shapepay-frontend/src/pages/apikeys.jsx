import React, { useState, useEffect, useContext } from 'react';
import { AuthContext } from '../context/use-auth';
import { supabase } from '../services/supabaseClient';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Key, Home, Plus, Copy, Check } from 'lucide-react';
import { Link } from 'react-router-dom';

const APIKeysPage = () => {
  const [keys, setKeys] = useState([]);
  const [open, setOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);
  const { user, activeMerchantId } = useContext(AuthContext);

  useEffect(() => {
    if (user && activeMerchantId) {
      fetchAPIKeys();
    }
  }, [user, activeMerchantId]);

  const fetchAPIKeys = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from('api_keys')
        .select('*')
        .eq('merchant_id', activeMerchantId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setKeys(data);
    } catch (error) {
      console.error('Error fetching API keys:', error);
      setError('Failed to fetch API keys. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) {
      setError('Please provide a name for the API key.');
      return;
    }
    setError(null);
    try {
      const { data, error } = await supabase.rpc('create_api_key', {
        p_merchant_id: activeMerchantId,
        p_name: newKeyName.trim(),
        p_expires_at: null
      });

      if (error) throw error;
      fetchAPIKeys();
      setOpen(false);
      setNewKeyName('');
    } catch (error) {
      console.error('Error creating new API key:', error);
      setError('Failed to create API key. Please try again.');
    }
  };

  const handleRevokeKey = async (id) => {
    setError(null);
    try {
      const { error } = await supabase
        .from('api_keys')
        .delete()
        .eq('id', id)
        .eq('merchant_id', activeMerchantId);

      if (error) throw error;
      fetchAPIKeys();
    } catch (error) {
      console.error('Error revoking API key:', error);
      setError('Failed to revoke API key. Please try again.');
    }
  };

  const handleCopyKey = (key) => {
    navigator.clipboard.writeText(key)
      .then(() => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2000);
      })
      .catch(err => console.error('Failed to copy text: ', err));
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center">
        <Alert>
          <AlertDescription>Please log in to manage your API keys.</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-gray-100"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      <div className="container mx-auto px-2 sm:px-4 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-2">
            <Link to="/" className="text-blue-400 hover:text-blue-300 flex items-center">
              <Home className="w-4 h-4 mr-1" />
              Home
            </Link>
            <span>/</span>
            <span className="flex items-center">
              <Key className="w-4 h-4 mr-1" />
              API Keys
            </span>
          </div>
          <Button onClick={() => setOpen(true)} className="bg-blue-500 hover:bg-blue-600">
            <Plus className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">New API Key</span>
          </Button>
        </div>

        <div className="space-y-6">
          <Card className="bg-gray-800 border-gray-700">
            <CardHeader>
              <CardTitle className="text-gray-100">API Keys Overview</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-300">Manage your API keys here. You can create new keys and revoke existing ones as needed.</p>
            </CardContent>
          </Card>

          <Card className="bg-gray-800 border-gray-700">
            <CardHeader>
              <CardTitle className="text-gray-100">Your API Keys</CardTitle>
            </CardHeader>
            <CardContent>
              {error && (
                <Alert variant="destructive" className="mb-4">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              {keys.length === 0 ? (
                <p className="text-gray-300">No API keys found. Create a new key to get started.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-b border-gray-700">
                        <TableHead className="text-gray-300">Name</TableHead>
                        <TableHead className="text-gray-300">Key</TableHead>
                        <TableHead className="text-gray-300">Created At</TableHead>
                        <TableHead className="text-gray-300">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {keys.map((row) => (
                        <TableRow key={row.id} className="border-b border-gray-700">
                          <TableCell className="text-gray-300">{row.name}</TableCell>
                          <TableCell className="text-gray-300 flex items-center">
                            <span className="mr-2">{row.key}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleCopyKey(row.key)}
                              className="p-1"
                            >
                              {copiedKey === row.key ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                            </Button>
                          </TableCell>
                          <TableCell className="text-gray-300">{new Date(row.created_at).toLocaleString()}</TableCell>
                          <TableCell>
                            <Button variant="destructive" size="sm" onClick={() => handleRevokeKey(row.id)}>Revoke</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="bg-gray-800 text-gray-100">
            <DialogHeader>
              <DialogTitle>Create New API Key</DialogTitle>
            </DialogHeader>
            <div className="py-4">
              <Input
                id="name"
                placeholder="API Key Name"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                className="bg-gray-700 text-gray-100"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} className="bg-gray-700 text-gray-100 hover:bg-gray-600">Cancel</Button>
              <Button onClick={handleCreateKey} className="bg-blue-500 hover:bg-blue-600">Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default APIKeysPage;