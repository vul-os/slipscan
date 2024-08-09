import React, { useEffect, useState, useContext } from 'react';
import { supabase } from '../services/supabaseClient';
import AuthContext from '../context/auth-context';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Home, Users, ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';

const CustomersPage = () => {
  const { user, signInWithGoogle } = useContext(AuthContext);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedCustomerId, setExpandedCustomerId] = useState(null);

  useEffect(() => {
    fetchCustomers();
  }, [user]);

  const fetchCustomers = async () => {
    if (user) {
      try {
        setLoading(true);
        const { data, error } = await supabase
          .from('customers')
          .select('*')
          .order('created_at', { ascending: false });

        if (error) throw error;
        setCustomers(data);
      } catch (error) {
        console.error('Error fetching customers:', error);
        setError('Error fetching customers');
      } finally {
        setLoading(false);
      }
    }
  };

  const handleRowClick = (customerId) => {
    setExpandedCustomerId(expandedCustomerId === customerId ? null : customerId);
  };

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
              <Users className="w-4 h-4 mr-1" />
              Customers
            </span>
          </div>
        </div>

        <Card className="mb-6 bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-100">Customers Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-300">This page displays all customers. Click on a row to view more details about a customer.</p>
          </CardContent>
        </Card>

        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-100">Customer List</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex justify-center items-center h-40">
                <p className="text-gray-300">Loading...</p>
              </div>
            ) : user ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-b border-gray-700">
                      <TableHead className="text-gray-300">ID</TableHead>
                      <TableHead className="text-gray-300">Name</TableHead>
                      <TableHead className="text-gray-300">Email</TableHead>
                      <TableHead className="hidden md:table-cell text-gray-300">Created At</TableHead>
                      <TableHead className="text-gray-300"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customers.map((customer) => (
                      <React.Fragment key={customer.id}>
                        <TableRow 
                          onClick={() => handleRowClick(customer.id)} 
                          className="cursor-pointer hover:bg-gray-700 border-b border-gray-700 transition-colors duration-150"
                        >
                          <TableCell>{customer.id}</TableCell>
                          <TableCell>{customer.name}</TableCell>
                          <TableCell>{customer.email}</TableCell>
                          <TableCell className="hidden md:table-cell">{new Date(customer.created_at).toLocaleString()}</TableCell>
                          <TableCell>
                            {expandedCustomerId === customer.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </TableCell>
                        </TableRow>
                        {expandedCustomerId === customer.id && (
                          <TableRow>
                            <TableCell colSpan="5" className="p-0">
                              <Card className="m-2 bg-gray-700 border-gray-600">
                                <CardHeader>
                                  <CardTitle className="text-gray-100">Customer Details</CardTitle>
                                </CardHeader>
                                <CardContent>
                                  <p className="text-gray-300">ID: {customer.id}</p>
                                  <p className="text-gray-300">Name: {customer.name}</p>
                                  <p className="text-gray-300">Email: {customer.email}</p>
                                  <p className="text-gray-300">Created At: {new Date(customer.created_at).toLocaleString()}</p>
                                  {/* Add more customer details here */}
                                </CardContent>
                              </Card>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="flex justify-center">
                <Button onClick={signInWithGoogle} className="bg-blue-500 hover:bg-blue-600">
                  Sign In with Google
                </Button>
              </div>
            )}
            {error && <p className="text-red-500 mt-4">{error}</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default CustomersPage;