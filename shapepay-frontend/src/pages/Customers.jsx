import React, { useEffect, useState, useContext } from 'react';
import { Container, Typography, CircularProgress, Box, Button } from '@mui/material';
import { supabase } from '../services/supabaseClient';
import AuthContext from '../context/AuthContext';
import DataTable from '../components/DataTable';

const Customers = () => {
  const { user, signInWithGoogle } = useContext(AuthContext);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchCustomers = async () => {
      if (user) {
        const { data, error } = await supabase
          .from('customers')
          .select('*');

        if (error) {
          setError('Error fetching customers');
        } else {
          setCustomers(data);
        }
        setLoading(false);
      }
    };

    fetchCustomers();
  }, [user]);

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" height="100vh">
        <CircularProgress />
      </Box>
    );
  }

  const columns = [
    { field: 'id', headerName: 'ID', width: 150 },
    { field: 'name', headerName: 'Name', width: 200 },
    { field: 'email', headerName: 'Email', width: 250 },
  ];

  return (
    <Container>
      <Typography variant="h4" gutterBottom>
        Customers
      </Typography>
      {error && <Typography color="error">{error}</Typography>}
      {user ? (
        <DataTable columns={columns} rows={customers} pageSize={10} />
      ) : (
        <Button variant="contained" color="primary" onClick={signInWithGoogle}>
          Sign In with Google
        </Button>
      )}
    </Container>
  );
};

export default Customers;
