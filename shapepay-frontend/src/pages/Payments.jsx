import React, { useState, useEffect } from 'react';
import { 
  Box, 
  Container, 
  Typography, 
  Paper,
  Breadcrumbs,
  Link,
  Dialog,
  DialogTitle,
  DialogContent,
  IconButton,
  Tooltip
} from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import CloseIcon from '@mui/icons-material/Close';
import HomeIcon from '@mui/icons-material/Home';
import PaymentIcon from '@mui/icons-material/Payment';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { supabase } from '../services/supabaseClient';

const PaymentsPage = () => {
  const [paymentGroups, setPaymentGroups] = useState([]);
  const [selectedPayments, setSelectedPayments] = useState([]);
  const [openDialog, setOpenDialog] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPaymentGroups();
  }, []);

  const fetchPaymentGroups = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('payment_groups')
        .select(`
          *,
          transaction_codes (
            code,
            status
          )
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setPaymentGroups(data.map(group => ({
        ...group,
        transactionCode: group.transaction_codes?.[0]?.code || 'N/A',
        codeStatus: group.transaction_codes?.[0]?.status || 'N/A'
      })));
    } catch (error) {
      console.error('Error fetching payment groups:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRowClick = async (params) => {
    const groupId = params.row.id;
    try {
      const { data, error } = await supabase
        .from('payments')
        .select('*')
        .eq('payment_group_id', groupId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setSelectedPayments(data);
      setOpenDialog(true);
    } catch (error) {
      console.error('Error fetching payments:', error);
    }
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      // You might want to show a snackbar or tooltip here to indicate successful copy
      console.log('Copied to clipboard');
    }, (err) => {
      console.error('Could not copy text: ', err);
    });
  };

  const paymentGroupColumns = [
    { field: 'id', headerName: 'ID', width: 220 },
    { field: 'txn_id', headerName: 'Transaction ID', width: 220 },
    { 
      field: 'total_amount', 
      headerName: 'Total Amount', 
      width: 130,
    },
    { field: 'status', headerName: 'Status', width: 130 },
    {
      field: 'transactionCode',
      headerName: 'Transaction Code',
      width: 180,
      renderCell: (params) => (
        <Tooltip title="Click to copy">
          <Box sx={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }} onClick={() => copyToClipboard(params.value)}>
            {params.value}
            <ContentCopyIcon fontSize="small" sx={{ ml: 1 }} />
          </Box>
        </Tooltip>
      ),
    },
    { field: 'codeStatus', headerName: 'Code Status', width: 130 },
    {
      field: 'created_at',
      headerName: 'Created At',
      width: 200,
    },
  ];

  const paymentColumns = [
    { field: 'id', headerName: 'ID', width: 220 },
    { 
      field: 'amount_charged', 
      headerName: 'Amount Charged', 
      width: 150,
      valueFormatter: (params) => {
        return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(params.value);
      },
    },
    { 
      field: 'amount_collected', 
      headerName: 'Amount Collected', 
      width: 150,
      valueFormatter: (params) => {
        return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(params.value);
      },
    },
    { field: 'status', headerName: 'Status', width: 130 },
    {
      field: 'created_at',
      headerName: 'Created At',
      width: 200,
      valueGetter: (params) => new Date(params.value).toLocaleString(),
    },
  ];

  return (
    <Container maxWidth="lg">
      <Box sx={{ mt: 4, mb: 4 }}>
        <Breadcrumbs aria-label="breadcrumb">
          <Link
            underline="hover"
            sx={{ display: 'flex', alignItems: 'center' }}
            color="inherit"
            href="/"
          >
            <HomeIcon sx={{ mr: 0.5 }} fontSize="inherit" />
            Home
          </Link>
          <Typography
            sx={{ display: 'flex', alignItems: 'center' }}
            color="text.primary"
          >
            <PaymentIcon sx={{ mr: 0.5 }} fontSize="inherit" />
            Payments
          </Typography>
        </Breadcrumbs>
      </Box>

      <Paper elevation={3} sx={{ p: 3, mb: 4 }}>
        <Typography variant="h4" gutterBottom component="div">
          Payments Overview
        </Typography>
        <Typography variant="body1" paragraph>
          This page displays all payment groups and their associated transaction codes. Click on a row to view individual payments within that group.
        </Typography>
      </Paper>

      <Paper elevation={3} sx={{ p: 3 }}>
        <Typography variant="h5" gutterBottom component="div">
          Payment Groups
        </Typography>
        <Box sx={{ height: 400, width: '100%' }}>
          <DataGrid
            rows={paymentGroups}
            columns={paymentGroupColumns}
            pageSize={5}
            rowsPerPageOptions={[5]}
            onRowClick={handleRowClick}
            loading={loading}
          />
        </Box>
      </Paper>

      <Dialog open={openDialog} onClose={handleCloseDialog} maxWidth="md" fullWidth>
        <DialogTitle>
          Payments
          <IconButton
            aria-label="close"
            onClick={handleCloseDialog}
            sx={{
              position: 'absolute',
              right: 8,
              top: 8,
            }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <DataGrid
            rows={selectedPayments}
            columns={paymentColumns}
            pageSize={5}
            rowsPerPageOptions={[5]}
            autoHeight
          />
        </DialogContent>
      </Dialog>
    </Container>
  );
};

export default PaymentsPage;