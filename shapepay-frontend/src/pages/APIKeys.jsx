import React, { useState, useEffect, useContext} from 'react';
import { 
  Typography, 
  Button, 
  Table, 
  TableBody, 
  TableCell, 
  TableContainer, 
  TableHead, 
  TableRow, 
  Paper, 
  TextField, 
  Dialog, 
  DialogActions, 
  DialogContent, 
  DialogTitle,
  Box,
  CircularProgress,
  Alert
} from '@mui/material';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import AuthContext from '../context/AuthContext';
import { supabase } from '../services/supabaseClient'

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

  const handleClickOpen = () => {
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
    setNewKeyName('');
  };

  const handleCreateKey = async () => {
    const { data, error } = await supabase.rpc('create_api_key', {
      p_merchant_id: merchantId,
      p_name: newKeyName,
      p_expires_at: null // You can add an expiration date picker if needed
    });

    if (error) {
      console.error('Error creating new API key:', error);
      setError('Failed to create API key.');
    } else {
      fetchAPIKeys(); // Refresh the list of keys
      handleClose();
    }
  };

  const handleRevokeKey = async (id) => {
    const { error } = await supabase
      .from('api_keys')
      .delete()
      .eq('id', id)
      .eq('merchant_id', merchantId); // Extra safety check

    if (error) {
      console.error('Error revoking API key:', error);
      setError('Failed to revoke API key.');
    } else {
      fetchAPIKeys(); // Refresh the list of keys
    }
  };

  if (!user) {
    return <Alert severity="info">Please log in to manage your API keys.</Alert>;
  }

  if (loading) {
    return <CircularProgress />;
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }

  return (
    <Box display="flex" flexDirection="column" alignItems="center" p={3}>
      <Button variant="contained" color="primary" onClick={handleClickOpen} startIcon={<VpnKeyIcon />} sx={{ mb: 2 }}>
        Create New API Key
      </Button>
      <TableContainer component={Paper} sx={{ maxWidth: 1200 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Key</TableCell>
              <TableCell>Created At</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {keys.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.name}</TableCell>
                <TableCell>{row.key}</TableCell>
                <TableCell>{new Date(row.created_at).toLocaleString()}</TableCell>
                <TableCell>
                  <Button variant="outlined" size="small" onClick={() => handleRevokeKey(row.id)}>Revoke</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Dialog open={open} onClose={handleClose}>
        <DialogTitle>Create New API Key</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            id="name"
            label="API Key Name"
            type="text"
            fullWidth
            variant="standard"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>Cancel</Button>
          <Button onClick={handleCreateKey}>Create</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default APIKeys;