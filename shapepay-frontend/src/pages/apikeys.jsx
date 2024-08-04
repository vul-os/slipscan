import React, { useState, useEffect, useContext } from 'react';
import AuthContext from '../context/auth-context';
import { supabase } from '../services/supabaseClient';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Key } from 'lucide-react';


const APIKeys = () => {
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
    return <Alert><AlertDescription>Please log in to manage your API keys.</AlertDescription></Alert>;
  }

  if (loading) {
    return <div className="flex justify-center"><div className="animate-spin rounded-full h-32 w-32 border-b-2 border-gray-900"></div></div>;
  }

  if (error) {
    return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  }

  return (
    <div className="flex flex-col items-center p-6">
      <Button onClick={() => setOpen(true)} className="mb-4">
        <Key className="mr-2 h-4 w-4" /> Create New API Key
      </Button>
      <div className="w-full max-w-4xl">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Created At</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.name}</TableCell>
                <TableCell>{row.key}</TableCell>
                <TableCell>{new Date(row.created_at).toLocaleString()}</TableCell>
                <TableCell>
                  <Button variant="outline" size="sm" onClick={() => handleRevokeKey(row.id)}>Revoke</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New API Key</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Input
              id="name"
              placeholder="API Key Name"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateKey}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default APIKeys;