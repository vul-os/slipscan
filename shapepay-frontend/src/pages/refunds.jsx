import React, { useState, useEffect, useContext } from 'react';
import { supabase } from '../services/supabaseClient';
import { AuthContext } from '../context/use-auth';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Banknote, Home } from 'lucide-react';
import { Link } from 'react-router-dom';

const Refunds = () => {
  const [refunds, setRefunds] = useState([]);
  const [open, setOpen] = useState(false);
  const [newRefundAmount, setNewRefundAmount] = useState('');
  const [newRefundReason, setNewRefundReason] = useState('');
  const [selectedTxn, setSelectedTxn] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const { user, activeMerchantId } = useContext(AuthContext);

  useEffect(() => {
    if (user && activeMerchantId) {
      fetchRefunds();
      fetchTransactions();
    }
  }, [user, activeMerchantId]);

  const fetchRefunds = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from('refunds')
        .select(`
          *,
          txns:txn_id (txn_number, total_amount)
        `)
        .eq('txns.merchant_id', activeMerchantId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setRefunds(data);
    } catch (error) {
      console.error('Error fetching refunds:', error);
      setError('Failed to fetch refunds. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  const fetchTransactions = async () => {
    setError(null);
    try {
      const { data, error } = await supabase
        .from('txns')
        .select('id, txn_number, total_amount')
        .eq('merchant_id', activeMerchantId)
        .eq('status', 'completed')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setTransactions(data);
    } catch (error) {
      console.error('Error fetching transactions:', error);
      setError('Failed to fetch transactions. Please try again later.');
    }
  };

  const handleCreateRefund = async () => {
    if (!selectedTxn || !newRefundAmount || !newRefundReason) {
      setError('Please fill in all fields.');
      return;
    }
    setError(null);
    try {
      const { error } = await supabase
        .from('refunds')
        .insert({
          txn_id: selectedTxn,
          amount: parseFloat(newRefundAmount),
          status: 'pending',
          reason: newRefundReason
        });

      if (error) throw error;
      
      fetchRefunds();
      setOpen(false);
      setNewRefundAmount('');
      setNewRefundReason('');
      setSelectedTxn('');
    } catch (error) {
      console.error('Error creating new refund:', error);
      setError('Failed to create refund. Please try again.');
    }
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <Alert>
          <AlertDescription>Please log in to manage your refunds.</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-gray-900"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <div className="container mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-2">
            <Link to="/" className="text-blue-600 hover:text-blue-800 flex items-center">
              <Home className="w-4 h-4 mr-1" />
              Home
            </Link>
            <span>/</span>
            <span className="flex items-center">
              <Banknote className="w-4 h-4 mr-1" />
              Refunds
            </span>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Refunds</CardTitle>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setOpen(true)} className="mb-4">
              <Banknote className="mr-2 h-4 w-4" /> Create New Refund
            </Button>
            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {refunds.length === 0 ? (
              <p>No refunds found. Create a new refund to get started.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Transaction</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Created At</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {refunds.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.txns.txn_number}</TableCell>
                      <TableCell>{row.amount.toFixed(2)} ZAR</TableCell>
                      <TableCell>{row.status}</TableCell>
                      <TableCell>{row.reason}</TableCell>
                      <TableCell>{new Date(row.created_at).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Refund</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="transaction" className="text-right">
                  Transaction
                </Label>
                <Select onValueChange={setSelectedTxn} value={selectedTxn}>
                  <SelectTrigger className="col-span-3">
                    <SelectValue placeholder="Select a transaction" />
                  </SelectTrigger>
                  <SelectContent>
                    {transactions.map((txn) => (
                      <SelectItem key={txn.id} value={txn.id}>
                        {txn.txn_number} - {txn.total_amount.toFixed(2)} ZAR
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="amount" className="text-right">
                  Amount
                </Label>
                <Input
                  id="amount"
                  type="number"
                  value={newRefundAmount}
                  onChange={(e) => setNewRefundAmount(e.target.value)}
                  className="col-span-3"
                />
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label htmlFor="reason" className="text-right">
                  Reason
                </Label>
                <Input
                  id="reason"
                  value={newRefundReason}
                  onChange={(e) => setNewRefundReason(e.target.value)}
                  className="col-span-3"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreateRefund}>Create Refund</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default Refunds;