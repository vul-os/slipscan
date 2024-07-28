import React, { useState, useEffect, useContext } from 'react';
import {
  Card,
  CardContent,
  Typography,
  Button,
  TextField,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Alert,
  Grid,
  Box,
  CircularProgress
} from '@mui/material';
import AuthContext from '../context/AuthContext';

const PaymentsPage = () => {
  const [balance, setBalance] = useState(0);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payouts, setPayouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { user } = useContext(AuthContext);

  useEffect(() => {
    if (user) {
      fetchBalance();
      fetchPayouts();
    }
  }, [user]);

  const fetchBalance = async () => {
    try {
      const response = await fetch('/api/balance', {
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (!response.ok) throw new Error('Failed to fetch balance');
      const data = await response.json();
      setBalance(data.balance);
    } catch (err) {
      setError('Failed to fetch balance');
    }
  };

  const fetchPayouts = async () => {
    try {
      const response = await fetch('/api/payouts/history', {
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      if (!response.ok) throw new Error('Failed to fetch payout history');
      const data = await response.json();
      setPayouts(data);
    } catch (err) {
      setError('Failed to fetch payout history');
    } finally {
      setLoading(false);
    }
  };

  const requestPayout = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const response = await fetch('/api/payouts/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.token}`
        },
        body: JSON.stringify({ amount: parseFloat(payoutAmount) })
      });
      if (!response.ok) throw new Error('Payout request failed');
      const data = await response.json();
      setPayouts([data, ...payouts]);
      setPayoutAmount('');
      setBalance(prevBalance => prevBalance - parseFloat(payoutAmount));
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="100vh">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ flexGrow: 1, p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Payments Dashboard
      </Typography>
      
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Current Balance
              </Typography>
              <Typography variant="h4">
                ${balance.toFixed(2)}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Request Payout
              </Typography>
              <Box component="form" onSubmit={requestPayout} sx={{ display: 'flex', alignItems: 'flex-end' }}>
                <TextField
                  type="number"
                  label="Amount"
                  value={payoutAmount}
                  onChange={(e) => setPayoutAmount(e.target.value)}
                  variant="outlined"
                  size="small"
                  InputProps={{ inputProps: { min: 0, step: 0.01 } }}
                  required
                  sx={{ mr: 1, flexGrow: 1 }}
                />
                <Button
                  type="submit"
                  variant="contained"
                  disabled={!payoutAmount || parseFloat(payoutAmount) > balance}
                >
                  Request
                </Button>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Payout History
          </Typography>
          <TableContainer component={Paper}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Date</TableCell>
                  <TableCell>Amount</TableCell>
                  <TableCell>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {payouts.map(payout => (
                  <TableRow key={payout.id}>
                    <TableCell>{new Date(payout.created_at).toLocaleDateString()}</TableCell>
                    <TableCell>${payout.amount.toFixed(2)}</TableCell>
                    <TableCell>{payout.status}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Box>
  );
};

export default PaymentsPage;