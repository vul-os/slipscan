import React, { useState, useEffect, useContext } from 'react';
import AuthContext from '../context/auth-context';
import { supabase } from '../services/supabaseClient';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Key, Home, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';

const APIKeysPage = () => {
  const [keys, setKeys] = useState([]);
  const [open, setOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [merchantId, setMerchantId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { user } = useContext(AuthContext);

  useEffect(() => {
    if (user) {
      fetchMerchantId();
    } 
  }, [user]);

  useEffect(() => {
    if (merchantId) {
      fetchAPIKeys();
    }
  }, [merchantId]);

  const fetchMerchantId = async () => {
    const { data, error } = await supabase
      .from('merchants')
      .select('id')
      .eq('user_id', user.id)
      .single();

    if (error) {
      console.error('Error fetching merchant ID:', error);
      setError('Failed to fetch merchant information.');
    } else {
      setMerchantId(data.id);
    }
    setLoading(false);
  };

  const fetchAPIKeys = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('api_keys')
      .select('*')
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching API keys:', error);
      setError('Failed to fetch API keys.');
    } else {
      setKeys(data);
    }
    setLoading(false);
  };

  const handleCreateKey = async () => {
    const { data, error } = await supabase.rpc('create_api_key', {
      p_merchant_id: merchantId,
      p_name: newKeyName,
      p_expires_at: null
    });

    if (error) {
      console.error('Error creating new API key:', error);
      setError('Failed to create API key.');
    } else {
      fetchAPIKeys();
      setOpen(false);
      setNewKeyName('');
    }
  };

  const handleRevokeKey = async (id) => {
    const { error } = await supabase
      .from('api_keys')
      .delete()
      .eq('id', id)
      .eq('merchant_id', merchantId);

    if (error) {
      console.error('Error revoking API key:', error);
      setError('Failed to revoke API key.');
    } else {
      fetchAPIKeys();
    }
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
      <div className="container mx-auto p-4">
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
            <Plus className="mr-2 h-4 w-4" /> New API Key
          </Button>
        </div>

        <Card className="mb-6 bg-gray-800 border-gray-700">
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
                      <TableCell className="text-gray-300">{row.key}</TableCell>
                      <TableCell className="text-gray-300">{new Date(row.created_at).toLocaleString()}</TableCell>
                      <TableCell>
                        <Button variant="destructive" size="sm" onClick={() => handleRevokeKey(row.id)}>Revoke</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

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