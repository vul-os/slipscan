import React, { useState, useEffect, useContext } from 'react';
import {
  Box,
  Typography,
  Grid,
  Paper,
  CircularProgress,
  Alert,
  Card,
  CardContent,
  List,
  ListItem,
  ListItemText,
  Divider,
} from '@mui/material';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import { supabase } from '../services/supabaseClient';
import AuthContext from '../context/AuthContext';

const Dashboard = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [merchantId, setMerchantId] = useState(null);
  const [metrics, setMetrics] = useState({
    totalTransactions: 0,
    totalRevenue: 0,
    successRate: 0,
    totalRefunds: 0,
  });
  const [recentTransactions, setRecentTransactions] = useState([]);
  const [dailyRevenue, setDailyRevenue] = useState([]);
  const { user } = useContext(AuthContext);

  useEffect(() => {
    if (user) {
      fetchMerchantId();
    }
  }, [user]);

  useEffect(() => {
    if (merchantId) {
      fetchDashboardData();
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
  };

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      await Promise.all([
        fetchMetrics(),
        fetchRecentTransactions(),
        fetchDailyRevenue(),
      ]);
    } catch (err) {
      console.error('Error fetching dashboard data:', err);
      setError('Failed to fetch dashboard data.');
    } finally {
      setLoading(false);
    }
  };

  const fetchMetrics = async () => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: transactions, error: txnError } = await supabase
      .from('txns')
      .select('id, total_amount, status')
      .eq('merchant_id', merchantId)
      .gte('created_at', thirtyDaysAgo.toISOString());

    if (txnError) {
      throw txnError;
    }

    const { data: refunds, error: refundError } = await supabase
      .from('refunds')
      .select('amount')
      .eq('merchant_id', merchantId)
      .gte('created_at', thirtyDaysAgo.toISOString());

    if (refundError) {
      throw refundError;
    }

    const totalTransactions = transactions.length;
    const totalRevenue = transactions.reduce((sum, txn) => sum + txn.total_amount, 0);
    const successfulTransactions = transactions.filter(txn => txn.status === 'completed').length;
    const successRate = totalTransactions > 0 ? (successfulTransactions / totalTransactions) * 100 : 0;
    const totalRefunds = refunds.reduce((sum, refund) => sum + refund.amount, 0);

    setMetrics({
      totalTransactions,
      totalRevenue,
      successRate,
      totalRefunds,
    });
  };

  const fetchRecentTransactions = async () => {
    const { data, error } = await supabase
      .from('txns')
      .select(`
        id, 
        txn_number, 
        total_amount, 
        status, 
        created_at,
        refunds (
          id,
          amount,
          created_at
        )
      `)
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) {
      throw error;
    }

    setRecentTransactions(data);
  };

  const fetchDailyRevenue = async () => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data, error } = await supabase
      .from('txns')
      .select('total_amount, created_at')
      .eq('merchant_id', merchantId)
      .gte('created_at', sevenDaysAgo.toISOString())
      .eq('status', 'completed');

    if (error) {
      throw error;
    }

    const dailyRevenue = data.reduce((acc, txn) => {
      const date = new Date(txn.created_at).toLocaleDateString();
      acc[date] = (acc[date] || 0) + txn.total_amount;
      return acc;
    }, {});

    const chartData = Object.entries(dailyRevenue).map(([date, amount]) => ({
      date,
      amount,
    }));

    setDailyRevenue(chartData);
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="100vh">
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box p={3}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ flexGrow: 1, p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Dashboard
      </Typography>
      <Grid container spacing={3}>
        {/* Metrics */}
        <Grid item xs={12} sm={6} md={3}>
          <Paper elevation={3} sx={{ p: 2 }}>
            <Typography variant="h6">Total Transactions</Typography>
            <Typography variant="h4">{metrics.totalTransactions}</Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper elevation={3} sx={{ p: 2 }}>
            <Typography variant="h6">Total Revenue</Typography>
            <Typography variant="h4">{metrics.totalRevenue.toFixed(2)} ZAR</Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper elevation={3} sx={{ p: 2 }}>
            <Typography variant="h6">Success Rate</Typography>
            <Typography variant="h4">{metrics.successRate.toFixed(2)}%</Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper elevation={3} sx={{ p: 2 }}>
            <Typography variant="h6">Total Refunds</Typography>
            <Typography variant="h4">{metrics.totalRefunds.toFixed(2)} ZAR</Typography>
          </Paper>
        </Grid>

        {/* Revenue Chart */}
        <Grid item xs={12} md={8}>
          <Paper elevation={3} sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom>Daily Revenue (Last 7 Days)</Typography>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={dailyRevenue}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="amount" fill="#8884d8" />
              </BarChart>
            </ResponsiveContainer>
          </Paper>
        </Grid>

        {/* Recent Transactions */}
        <Grid item xs={12} md={4}>
          <Card elevation={3}>
            <CardContent>
              <Typography variant="h6" gutterBottom>Recent Transactions</Typography>
              <List>
                {recentTransactions.map((txn, index) => (
                  <React.Fragment key={txn.id}>
                    <ListItem alignItems="flex-start">
                      <ListItemText
                        primary={`${txn.total_amount.toFixed(2)} ZAR`}
                        secondary={
                          <>
                            <Typography
                              component="span"
                              variant="body2"
                              color="text.primary"
                            >
                              {txn.txn_number} - {txn.status}
                            </Typography>
                            {" — "}{new Date(txn.created_at).toLocaleString()}
                            {txn.refunds && txn.refunds.length > 0 && (
                              <Typography
                                component="div"
                                variant="body2"
                                color="error"
                              >
                                Refunded: {txn.refunds[0].amount.toFixed(2)} ZAR
                                {" — "}{new Date(txn.refunds[0].created_at).toLocaleString()}
                              </Typography>
                            )}
                          </>
                        }
                      />
                    </ListItem>
                    {index < recentTransactions.length - 1 && <Divider component="li" />}
                  </React.Fragment>
                ))}
              </List>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};

export default Dashboard;