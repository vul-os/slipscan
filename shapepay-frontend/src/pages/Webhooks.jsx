import React, { useState, useEffect, useContext } from 'react';
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
  Alert,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Switch
} from '@mui/material';
import WebhookIcon from '@mui/icons-material/Webhook';
import AuthContext from '../context/AuthContext';
import { supabase } from '../services/supabaseClient';

const Webhooks = () => {
  const [webhooks, setWebhooks] = useState([]);
  const [open, setOpen] = useState(false);
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [newWebhookEventType, setNewWebhookEventType] = useState('');
  const [merchantId, setMerchantId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { user } = useContext(AuthContext);

  const eventTypes = ['payment.successful', 'payment.failed', 'refund.successful', 'payout.created'];

  useEffect(() => {
    if (user) {
      fetchMerchantId();
    }
  }, [user]);

  useEffect(() => {
    if (merchantId) {
      fetchWebhooks();
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

  const fetchWebhooks = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('webhooks')
      .select('*')
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching webhooks:', error);
      setError('Failed to fetch webhooks.');
    } else {
      setWebhooks(data);
    }
    setLoading(false);
  };

  const handleClickOpen = () => {
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
    setNewWebhookUrl('');
    setNewWebhookEventType('');
  };

  const handleCreateWebhook = async () => {
    const { data, error } = await supabase
      .from('webhooks')
      .insert({
        merchant_id: merchantId,
        url: newWebhookUrl,
        event_type: newWebhookEventType,
        is_active: true
      });

    if (error) {
      console.error('Error creating new webhook:', error);
      setError('Failed to create webhook.');
    } else {
      fetchWebhooks();
      handleClose();
    }
  };

  const handleToggleWebhook = async (id, currentStatus) => {
    const { error } = await supabase
      .from('webhooks')
      .update({ is_active: !currentStatus })
      .eq('id', id)
      .eq('merchant_id', merchantId);

    if (error) {
      console.error('Error toggling webhook status:', error);
      setError('Failed to update webhook status.');
    } else {
      fetchWebhooks();
    }
  };

  const handleDeleteWebhook = async (id) => {
    const { error } = await supabase
      .from('webhooks')
      .delete()
      .eq('id', id)
      .eq('merchant_id', merchantId);

    if (error) {
      console.error('Error deleting webhook:', error);
      setError('Failed to delete webhook.');
    } else {
      fetchWebhooks();
    }
  };

  if (!user) {
    return <Alert severity="info">Please log in to manage your webhooks.</Alert>;
  }

  if (loading) {
    return <CircularProgress />;
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }

  return (
    <Box display="flex" flexDirection="column" alignItems="center" p={3}>
      <Button variant="contained" color="primary" onClick={handleClickOpen} startIcon={<WebhookIcon />} sx={{ mb: 2 }}>
        Create New Webhook
      </Button>
      <TableContainer component={Paper} sx={{ maxWidth: 1200 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>URL</TableCell>
              <TableCell>Event Type</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Created At</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {webhooks.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.url}</TableCell>
                <TableCell>{row.event_type}</TableCell>
                <TableCell>
                  <Switch
                    checked={row.is_active}
                    onChange={() => handleToggleWebhook(row.id, row.is_active)}
                    color="primary"
                  />
                </TableCell>
                <TableCell>{new Date(row.created_at).toLocaleString()}</TableCell>
                <TableCell>
                  <Button variant="outlined" size="small" onClick={() => handleDeleteWebhook(row.id)}>Delete</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Dialog open={open} onClose={handleClose}>
        <DialogTitle>Create New Webhook</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            id="url"
            label="Webhook URL"
            type="url"
            fullWidth
            variant="standard"
            value={newWebhookUrl}
            onChange={(e) => setNewWebhookUrl(e.target.value)}
          />
          <FormControl fullWidth variant="standard" sx={{ mt: 2 }}>
            <InputLabel id="event-type-label">Event Type</InputLabel>
            <Select
              labelId="event-type-label"
              id="event-type"
              value={newWebhookEventType}
              onChange={(e) => setNewWebhookEventType(e.target.value)}
              label="Event Type"
            >
              {eventTypes.map((type) => (
                <MenuItem key={type} value={type}>{type}</MenuItem>
              ))}
            </Select>
          </FormControl>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>Cancel</Button>
          <Button onClick={handleCreateWebhook}>Create</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Webhooks;