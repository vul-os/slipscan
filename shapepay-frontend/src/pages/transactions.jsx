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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

  const handleOpenDetails = (transaction) => {
    setSelectedTransaction(transaction);
  };

  const handleCloseDetails = () => {
    setSelectedTransaction(null);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Transactions, Payment Groups, and Payments</h1>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <DatePicker
          selected={filter.startDate}
          onSelect={(date) => handleFilterChange('startDate', date)}
          placeholderText="Start Date"
        />
        <DatePicker
          selected={filter.endDate}
          onSelect={(date) => handleFilterChange('endDate', date)}
          placeholderText="End Date"
        />
        <Select onValueChange={(value) => handleFilterChange('status', value)} value={filter.status}>
          <SelectTrigger>
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
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <Card>
          <CardHeader>
            <CardTitle>Total Transaction Amount</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-blue-600">{totalAmount.toFixed(2)} ZAR</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Total Amount Collected</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-green-600">{totalCollected.toFixed(2)} ZAR</p>
          </CardContent>
        </Card>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Transaction Number</TableHead>
              <TableHead>Customer Name</TableHead>
              <TableHead>Customer Email</TableHead>
              <TableHead>Total Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.map((transaction) => (
              <TableRow key={transaction.id}>
                <TableCell>{new Date(transaction.created_at).toLocaleDateString()}</TableCell>
                <TableCell>{transaction.txn_number}</TableCell>
                <TableCell>{transaction.customer_name}</TableCell>
                <TableCell>{transaction.customer_email}</TableCell>
                <TableCell>{Number(transaction.total_amount).toFixed(2)} ZAR</TableCell>
                <TableCell>
                  <Badge variant={transaction.status === 'completed' ? 'success' : transaction.status === 'processing' ? 'warning' : 'destructive'}>
                    {transaction.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button onClick={() => handleOpenDetails(transaction)}>View Details</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={Boolean(selectedTransaction)} onOpenChange={handleCloseDetails}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transaction Details: {selectedTransaction?.txn_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Payment Groups</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Payment Group ID</TableHead>
                    <TableHead>Group Total</TableHead>
                    <TableHead>Group Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedTransaction?.payment_groups.map((group) => (
                    <TableRow key={group.id}>
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
              <h3 className="text-lg font-semibold mb-2">Payments</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>PayShap Transaction ID</TableHead>
                    <TableHead>Amount Charged</TableHead>
                    <TableHead>Amount Collected</TableHead>
                    <TableHead>Payment Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedTransaction?.payment_groups.flatMap(group => group.payments).map((payment) => (
                    <TableRow key={payment.id}>
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
          <DialogFooter>
            <Button onClick={handleCloseDetails}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TransactionsPage;