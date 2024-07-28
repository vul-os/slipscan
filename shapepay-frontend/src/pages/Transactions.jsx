import React, { useState, useEffect, useContext } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Grid,
  CircularProgress,
  Alert,
  Chip,
} from '@mui/material';
import { DataGrid, GridToolbar } from '@mui/x-data-grid';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import AuthContext from '../context/AuthContext';
import { supabase } from '../services/supabaseClient';

// Custom theme for DataGrid
const dataGridTheme = createTheme({
  components: {
    MuiDataGrid: {
      styleOverrides: {
        root: {
          backgroundColor: '#fff',
          '& .MuiDataGrid-cell:focus': {
            outline: 'none',
          },
        },
        columnHeader: {
          backgroundColor: '#f5f5f5',
          color: '#1976d2',
          fontWeight: 'bold',
        },
      },
    },
  },
});

const TransactionsPage = () => {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState({
    startDate: null,
    endDate: null,
    status: 'all',
    search: '',
  });
  const [merchantId, setMerchantId] = useState(null);
  const { user } = useContext(AuthContext);

  useEffect(() => {
    if (user) {
      fetchMerchantId();
    }
  }, [user]);

  useEffect(() => {
    if (merchantId) {
      fetchTransactions();
    }
  }, [merchantId, filter]);

  const fetchMerchantId = async () => {
    const { data, error } = await supabase
      .from('merchants')
      .select('id')
      .eq('user_id', user?.id)
      .single();

    if (error) {
      console.error('Error fetching merchant ID:', error);
      setError('Failed to fetch merchant information.');
    } else {
      setMerchantId(data?.id);
    }
  };

  const fetchTransactions = async () => {
    setLoading(true);
    let query = supabase
      .from('txns')
      .select(`
        id,
        created_at,
        txn_number,
        total_amount,
        status,
        type,
        customers (
          name,
          email
        ),
        payment_groups (
          id,
          total_amount,
          status,
          payments (
            id,
            amount_charged,
            amount_collected,
            status,
            payshap_transaction_id
          )
        )
      `)
      .eq('merchant_id', merchantId);

    if (filter.startDate) {
      query = query.gte('created_at', filter.startDate.toISOString());
    }
    if (filter.endDate) {
      query = query.lte('created_at', filter.endDate.toISOString());
    }
    if (filter.status !== 'all') {
      query = query.eq('status', filter.status);
    }
    if (filter.search) {
      query = query.ilike('txn_number', `%${filter.search}%`);
    }

    query = query.order('created_at', { ascending: false });

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching transactions:', error);
      setError('Failed to fetch transactions');
      setLoading(false);
      return;
    }

    const processedData = data.map(txn => ({
      ...txn,
      customer_name: txn.customers?.name,
      customer_email: txn.customers?.email,
    }));

    setTransactions(processedData);
    setLoading(false);
  };

  const handleFilterChange = (field, value) => {
    setFilter(prev => ({ ...prev, [field]: value }));
  };

  const calculateTotals = () => {
    return transactions.reduce((acc, txn) => {
      acc.totalAmount += Number(txn.total_amount) || 0;
      acc.totalCollected += txn.payment_groups.reduce((groupSum, group) => 
        groupSum + group.payments.reduce((paymentSum, payment) => 
          paymentSum + (Number(payment.amount_collected) || 0), 0), 0);
      return acc;
    }, { totalAmount: 0, totalCollected: 0 });
  };

  const { totalAmount, totalCollected } = calculateTotals();

  const transactionColumns = [
    { 
      field: 'created_at', 
      headerName: 'Date', 
      width: 120,
      valueFormatter: (params) => params.value ? new Date(params.value).toLocaleDateString() : 'N/A',
    },
    { field: 'txn_number', headerName: 'Transaction Number', width: 200 },
    { field: 'customer_name', headerName: 'Customer Name', width: 200 },
    { field: 'customer_email', headerName: 'Customer Email', width: 200 },
    { 
      field: 'total_amount', 
      headerName: 'Total Amount', 
      type: 'number', 
      width: 150,
      valueFormatter: (params) => params.value != null ? `${Number(params.value).toFixed(2)} ZAR` : 'N/A',
    },
    { 
      field: 'status', 
      headerName: 'Status', 
      width: 120,
      renderCell: (params) => (
        <Chip 
          label={params.value || 'Unknown'} 
          color={params.value === 'completed' ? 'success' : params.value === 'processing' ? 'warning' : 'default'}
          size="small"
        />
      ),
    },
  ];

  const paymentGroupColumns = [
    { field: 'id', headerName: 'Payment Group ID', width: 200 },
    { 
      field: 'total_amount', 
      headerName: 'Group Total', 
      type: 'number', 
      width: 150,
      valueFormatter: (params) => params.value != null ? `${Number(params.value).toFixed(2)} ZAR` : 'N/A',
    },
    { 
      field: 'status', 
      headerName: 'Group Status', 
      width: 120,
      renderCell: (params) => (
        <Chip 
          label={params.value || 'Unknown'} 
          color={params.value === 'completed' ? 'success' : params.value === 'processing' ? 'warning' : 'default'}
          size="small"
        />
      ),
    },
  ];

  const paymentColumns = [
    { field: 'payshap_transaction_id', headerName: 'PayShap Transaction ID', width: 200 },
    { 
      field: 'amount_charged', 
      headerName: 'Amount Charged', 
      type: 'number', 
      width: 150,
      valueFormatter: (params) => params.value != null ? `${Number(params.value).toFixed(2)} ZAR` : 'N/A',
    },
    { 
      field: 'amount_collected', 
      headerName: 'Amount Collected', 
      type: 'number', 
      width: 150,
      valueFormatter: (params) => params.value != null ? `${Number(params.value).toFixed(2)} ZAR` : 'N/A',
    },
    { 
      field: 'status', 
      headerName: 'Payment Status', 
      width: 120,
      renderCell: (params) => (
        <Chip 
          label={params.value || 'Unknown'} 
          color={params.value === 'completed' ? 'success' : params.value === 'processing' ? 'warning' : 'default'}
          size="small"
        />
      ),
    },
  ];

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="100vh">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      <Box sx={{ flexGrow: 1, p: 3 }}>
        <Typography variant="h4" gutterBottom sx={{ mb: 4 }}>
          Transactions, Payment Groups, and Payments
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Grid container spacing={3} sx={{ mb: 4 }}>
          <Grid item xs={12} md={3}>
            <DatePicker
              label="Start Date"
              value={filter.startDate}
              onChange={(newValue) => handleFilterChange('startDate', newValue)}
              renderInput={(params) => <TextField {...params} fullWidth />}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <DatePicker
              label="End Date"
              value={filter.endDate}
              onChange={(newValue) => handleFilterChange('endDate', newValue)}
              renderInput={(params) => <TextField {...params} fullWidth />}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <FormControl fullWidth>
              <InputLabel>Status</InputLabel>
              <Select
                value={filter.status}
                label="Status"
                onChange={(e) => handleFilterChange('status', e.target.value)}
              >
                <MenuItem value="all">All</MenuItem>
                <MenuItem value="completed">Completed</MenuItem>
                <MenuItem value="processing">Processing</MenuItem>
                <MenuItem value="failed">Failed</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          <Grid item xs={12} md={3}>
            <TextField
              fullWidth
              label="Search Transaction Number"
              value={filter.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
            />
          </Grid>
        </Grid>

        <Grid container spacing={3} sx={{ mb: 4 }}>
          <Grid item xs={12} md={6}>
            <Card elevation={3}>
              <CardContent>
                <Typography variant="h6" gutterBottom>Total Transaction Amount</Typography>
                <Typography variant="h4" color="primary.main">{totalAmount.toFixed(2)} ZAR</Typography>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} md={6}>
            <Card elevation={3}>
              <CardContent>
                <Typography variant="h6" gutterBottom>Total Amount Collected</Typography>
                <Typography variant="h4" color="success.main">{totalCollected.toFixed(2)} ZAR</Typography>
              </CardContent>
            </Card>
          </Grid>
        </Grid>

        <ThemeProvider theme={dataGridTheme}>
          <Box sx={{ height: 600, width: '100%' }}>
            <DataGrid
              rows={transactions}
              columns={transactionColumns}
              pageSize={10}
              rowsPerPageOptions={[10, 20, 50]}
              checkboxSelection
              disableSelectionOnClick
              components={{
                Toolbar: GridToolbar,
              }}
              getDetailPanelContent={(params) => (
                <Box sx={{ p: 2 }}>
                  <Typography variant="h6" gutterBottom>Payment Groups</Typography>
                  <DataGrid
                    rows={params.row.payment_groups}
                    columns={paymentGroupColumns}
                    pageSize={5}
                    autoHeight
                    hideFooter
                    getDetailPanelContent={(groupParams) => (
                      <Box sx={{ p: 2 }}>
                        <Typography variant="h6" gutterBottom>Payments</Typography>
                        <DataGrid
                          rows={groupParams.row.payments}
                          columns={paymentColumns}
                          pageSize={5}
                          autoHeight
                          hideFooter
                        />
                      </Box>
                    )}
                    getDetailPanelHeight={() => 'auto'}
                  />
                </Box>
              )}
              getDetailPanelHeight={() => 'auto'}
            />
          </Box>
        </ThemeProvider>
      </Box>
    </LocalizationProvider>
  );
};

export default TransactionsPage;