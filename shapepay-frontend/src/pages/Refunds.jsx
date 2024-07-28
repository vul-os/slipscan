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
  FormControl,
  InputLabel,
  Select,
  MenuItem
} from '@mui/material';
import RefundIcon from '@mui/icons-material/MoneyOff';
import AuthContext from '../context/AuthContext';
import { supabase } from '../services/supabaseClient';

const Refunds = () => {
  const [refunds, setRefunds] = useState([]);
  const [open, setOpen] = useState(false);
  const [newRefundAmount, setNewRefundAmount] = useState('');
  const [newRefundReason, setNewRefundReason] = useState('');
  const [selectedTxn, setSelectedTxn] = useState('');
  const [merchantId, setMerchantId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const { user } = useContext(AuthContext);

  useEffect(() => {
    if (user) {
      fetchMerchantId();
    }
  }, [user]);

  useEffect(() => {
    if (merchantId) {
      fetchRefunds();
      fetchTransactions();
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

  const fetchRefunds = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('refunds')
      .select(`
        *,
        txns:txn_id (txn_number, total_amount),
        payments:payment_id (payshap_transaction_id)
      `)
      .eq('txns.merchant_id', merchantId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching refunds:', error);
      setError('Failed to fetch refunds.');
    } else {
      setRefunds(data);
    }
    setLoading(false);
  };

  const fetchTransactions = async () => {
    const { data, error } = await supabase
      .from('txns')
      .select('id, txn_number, total_amount')
      .eq('merchant_id', merchantId)
      .eq('status', 'completed')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching transactions:', error);
    } else {
      setTransactions(data);
    }
  };

  const handleClickOpen = () => {
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
    setNewRefundAmount('');
    setNewRefundReason('');
    setSelectedTxn('');
  };

  const handleCreateRefund = async () => {
    const { data: paymentData, error: paymentError } = await supabase
      .from('payments')
      .select('id')
      .eq('txn_id', selectedTxn)
      .single();

    if (paymentError) {
      console.error('Error fetching payment:', paymentError);
      setError('Failed to fetch payment information.');
      return;
    }

    const { data, error } = await supabase
      .from('refunds')
      .insert({
        txn_id: selectedTxn,
        payment_id: paymentData.id,
        amount: parseFloat(newRefundAmount),
        status: 'pending',
        reason: newRefundReason
      });

    if (error) {
      console.error('Error creating new refund:', error);
      setError('Failed to create refund.');
    } else {
      fetchRefunds();
      handleClose();
    }
  };

  if (!user) {
    return <Alert severity="info">Please log in to manage your refunds.</Alert>;
  }

  if (loading) {
    return <CircularProgress />;
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }

  return (
    <Box display="flex" flexDirection="column" alignItems="center" p={3}>
      <Button variant="contained" color="primary" onClick={handleClickOpen} startIcon={<RefundIcon />} sx={{ mb: 2 }}>
        Create New Refund
      </Button>
      <TableContainer component={Paper} sx={{ maxWidth: 1200 }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Transaction</TableCell>
              <TableCell>PayShap ID</TableCell>
              <TableCell>Amount</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Reason</TableCell>
              <TableCell>Created At</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {refunds.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.txns.txn_number}</TableCell>
                <TableCell>{row.payments.payshap_transaction_id}</TableCell>
                <TableCell>{row.amount.toFixed(2)} ZAR</TableCell>
                <TableCell>{row.status}</TableCell>
                <TableCell>{row.reason}</TableCell>
                <TableCell>{new Date(row.created_at).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Dialog open={open} onClose={handleClose}>
        <DialogTitle>Create New Refund</DialogTitle>
        <DialogContent>
          <FormControl fullWidth variant="standard" sx={{ mt: 2 }}>
            <InputLabel id="transaction-label">Transaction</InputLabel>
            <Select
              labelId="transaction-label"
              id="transaction"
              value={selectedTxn}
              onChange={(e) => setSelectedTxn(e.target.value)}
              label="Transaction"
            >
              {transactions.map((txn) => (
                <MenuItem key={txn.id} value={txn.id}>
                  {txn.txn_number} - {txn.total_amount.toFixed(2)} ZAR
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            margin="dense"
            id="amount"
            label="Refund Amount"
            type="number"
            fullWidth
            variant="standard"
            value={newRefundAmount}
            onChange={(e) => setNewRefundAmount(e.target.value)}
          />
          <TextField
            margin="dense"
            id="reason"
            label="Refund Reason"
            type="text"
            fullWidth
            variant="standard"
            value={newRefundReason}
            onChange={(e) => setNewRefundReason(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>Cancel</Button>
          <Button onClick={handleCreateRefund}>Create Refund</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Refunds;