import React, { useState, useEffect, useContext } from 'react';
import { supabase } from '../services/supabaseClient';
import AuthContext from '../context/auth-context';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Banknote } from 'lucide-react';

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
      setOpen(false);
      setNewRefundAmount('');
      setNewRefundReason('');
      setSelectedTxn('');
    }
  };

  if (!user) {
    return <Alert><AlertDescription>Please log in to manage your refunds.</AlertDescription></Alert>;
  }

  if (loading) {
    return <div className="flex justify-center"><div className="animate-spin rounded-full h-32 w-32 border-b-2 border-gray-900"></div></div>;
  }

  if (error) {
    return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  }

  return (
    <div className="p-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Refunds</CardTitle>
        </CardHeader>
        <CardContent>
          <Button onClick={() => setOpen(true)} className="mb-4">
            <Banknote className="mr-2 h-4 w-4" /> Create New Refund
          </Button>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Transaction</TableHead>
                <TableHead>PayShap ID</TableHead>
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
                  <TableCell>{row.payments.payshap_transaction_id}</TableCell>
                  <TableCell>{row.amount.toFixed(2)} ZAR</TableCell>
                  <TableCell>{row.status}</TableCell>
                  <TableCell>{row.reason}</TableCell>
                  <TableCell>{new Date(row.created_at).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
  );
};

export default Refunds;