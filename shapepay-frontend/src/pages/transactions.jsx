import React, { useState, useEffect, useContext } from 'react';
import { supabase } from '../services/supabaseClient';
import AuthContext from '../context/auth-context';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { DatePicker } from "@/components/ui/date-picker";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Home, CreditCard, ChevronDown, ChevronUp } from 'lucide-react';
import { Link } from 'react-router-dom';

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
  const [selectedTransaction, setSelectedTransaction] = useState(null);
  const [expandedTransactionId, setExpandedTransactionId] = useState(null);
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
    try {
      const { data, error } = await supabase
        .from('merchants')
        .select('id')
        .eq('user_id', user?.id)
        .single();

      if (error) throw error;

      setMerchantId(data?.id);
    } catch (error) {
      console.error('Error fetching merchant ID:', error);
      setError('Failed to fetch merchant information.');
    }
  };

  const fetchTransactions = async () => {
    setLoading(true);
    setError(null);
    try {
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

      if (error) throw error;

      const processedData = data.map(txn => ({
        ...txn,
        customer_name: txn.customers?.name,
        customer_email: txn.customers?.email,
      }));

      setTransactions(processedData);
    } catch (error) {
      console.error('Error fetching transactions:', error);
      setError('Failed to fetch transactions');
    } finally {
      setLoading(false);
    }
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

  const handleRowClick = (transactionId) => {
    setExpandedTransactionId(expandedTransactionId === transactionId ? null : transactionId);
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
              <CreditCard className="w-4 h-4 mr-1" />
              Transactions
            </span>
          </div>
        </div>

        <Card className="mb-6 bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-100">Transactions Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-300">This page displays all transactions, payment groups, and payments. Use the filters to narrow down your search.</p>
          </CardContent>
        </Card>

        <Card className="mb-6 bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-100">Filters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <DatePicker
                selected={filter.startDate}
                onSelect={(date) => handleFilterChange('startDate', date)}
                placeholderText="Start Date"
                className="bg-gray-700 text-white"
              />
              <DatePicker
                selected={filter.endDate}
                onSelect={(date) => handleFilterChange('endDate', date)}
                placeholderText="End Date"
                className="bg-gray-700 text-white"
              />
              <Select onValueChange={(value) => handleFilterChange('status', value)} value={filter.status}>
                <SelectTrigger className="bg-gray-700 text-white">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="processing">Processing</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Search Transaction Number"
                value={filter.search}
                onChange={(e) => handleFilterChange('search', e.target.value)}
                className="bg-gray-700 text-white"
              />
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <Card className="bg-gray-800 border-gray-700">
            <CardHeader>
              <CardTitle className="text-gray-100">Total Transaction Amount</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-blue-400">{totalAmount.toFixed(2)} ZAR</p>
            </CardContent>
          </Card>
          <Card className="bg-gray-800 border-gray-700">
            <CardHeader>
              <CardTitle className="text-gray-100">Total Amount Collected</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-green-400">{totalCollected.toFixed(2)} ZAR</p>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-100">Transactions</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex justify-center items-center h-40">
                <p className="text-gray-300">Loading...</p>
              </div>
            ) : error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-b border-gray-700">
                      <TableHead className="text-gray-300">Date</TableHead>
                      <TableHead className="text-gray-300">Transaction Number</TableHead>
                      <TableHead className="text-gray-300">Customer Name</TableHead>
                      <TableHead className="text-gray-300">Total Amount</TableHead>
                      <TableHead className="text-gray-300">Status</TableHead>
                      <TableHead className="text-gray-300"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {transactions.map((transaction) => (
                      <React.Fragment key={transaction.id}>
                        <TableRow 
                          onClick={() => handleRowClick(transaction.id)} 
                          className="cursor-pointer hover:bg-gray-700 border-b border-gray-700 transition-colors duration-150"
                        >
                          <TableCell>{new Date(transaction.created_at).toLocaleDateString()}</TableCell>
                          <TableCell>{transaction.txn_number}</TableCell>
                          <TableCell>{transaction.customer_name}</TableCell>
                          <TableCell>{Number(transaction.total_amount).toFixed(2)} ZAR</TableCell>
                          <TableCell>
                            <Badge variant={transaction.status === 'completed' ? 'success' : transaction.status === 'processing' ? 'warning' : 'destructive'}>
                              {transaction.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {expandedTransactionId === transaction.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </TableCell>
                        </TableRow>
                        {expandedTransactionId === transaction.id && (
                          <TableRow>
                            <TableCell colSpan="6" className="p-0">
                              <Card className="m-2 bg-gray-700 border-gray-600">
                                <CardHeader>
                                  <CardTitle className="text-gray-100">Transaction Details</CardTitle>
                                </CardHeader>
                                <CardContent>
                                  <div className="space-y-4">
                                    <div>
                                      <h3 className="text-lg font-semibold mb-2 text-gray-200">Payment Groups</h3>
                                      <Table>
                                        <TableHeader>
                                          <TableRow className="border-b border-gray-600">
                                            <TableHead className="text-gray-300">Payment Group ID</TableHead>
                                            <TableHead className="text-gray-300">Group Total</TableHead>
                                            <TableHead className="text-gray-300">Group Status</TableHead>
                                          </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {transaction.payment_groups.map((group) => (
                                            <TableRow key={group.id} className="border-b border-gray-600">
                                              <TableCell>{group.id}</TableCell>
                                              <TableCell>{Number(group.total_amount).toFixed(2)} ZAR</TableCell>
                                              <TableCell>
                                                <Badge variant={group.status === 'completed' ? 'success' : group.status === 'processing' ? 'warning' : 'destructive'}>
                                                  {group.status}
                                                </Badge>
                                              </TableCell>
                                            </TableRow>
                                          ))}
                                        </TableBody>
                                      </Table>
                                    </div>
                                    <div>
                                      <h3 className="text-lg font-semibold mb-2 text-gray-200">Payments</h3>
                                      <Table>
                                        <TableHeader>
                                          <TableRow className="border-b border-gray-600">
                                            <TableHead className="text-gray-300">PayShap Transaction ID</TableHead>
                                            <TableHead className="text-gray-300">Amount Charged</TableHead>
                                            <TableHead className="text-gray-300">Amount Collected</TableHead>
                                            <TableHead className="text-gray-300">Payment Status</TableHead>
                                          </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {transaction.payment_groups.flatMap(group => group.payments).map((payment) => (
                                            <TableRow key={payment.id} className="border-b border-gray-600">
                                              <TableCell>{payment.payshap_transaction_id}</TableCell>
                                              <TableCell>{Number(payment.amount_charged).toFixed(2)} ZAR</TableCell>
                                              <TableCell>{Number(payment.amount_collected).toFixed(2)} ZAR</TableCell>
                                              <TableCell>
                                                <Badge variant={payment.status === 'completed' ? 'success' : payment.status === 'processing' ? 'warning' : 'destructive'}>
                                                  {payment.status}
                                                </Badge>
                                              </TableCell>
                                            </TableRow>
                                          ))}
                                        </TableBody>
                                      </Table>
                                    </div>
                                  </div>
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
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default TransactionsPage;