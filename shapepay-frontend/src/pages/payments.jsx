import React, { useState, useEffect } from 'react';
import { supabase } from '../services/supabaseClient';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Home, CreditCard as Payment, Copy, X } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

const PaymentsPage = () => {
  const [paymentGroups, setPaymentGroups] = useState([]);
  const [selectedPayments, setSelectedPayments] = useState([]);
  const [openDialog, setOpenDialog] = useState(false);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

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

  const handleRowClick = async (groupId) => {
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

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      console.log('Copied to clipboard');
    }, (err) => {
      console.error('Could not copy text: ', err);
    });
  };

  return (
    <div className="container mx-auto p-4">
      <div className="flex items-center space-x-2 mb-4">
        <Link to="/" className="text-blue-500 hover:underline flex items-center">
          <Home className="w-4 h-4 mr-1" />
          Home
        </Link>
        <span>/</span>
        <span className="flex items-center">
          <Payment className="w-4 h-4 mr-1" />
          Payments
        </span>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Payments Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <p>This page displays all payment groups and their associated transaction codes. Click on a row to view individual payments within that group.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment Groups</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center items-center h-40">
              <p>Loading...</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Transaction ID</TableHead>
                    <TableHead>External Reference ID</TableHead> {/* New Column */}
                    <TableHead>Total Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Transaction Code</TableHead>
                    <TableHead>Code Status</TableHead>
                    <TableHead>Created At</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paymentGroups.map((group) => (
                    <TableRow key={group.id} onClick={() => handleRowClick(group.id)} className="cursor-pointer hover:bg-gray-100">
                      <TableCell>{group.id}</TableCell>
                      <TableCell>{group.txn_id}</TableCell>
                      <TableCell>{group.external_reference_id || 'N/A'}</TableCell> {/* Display External Reference ID */}
                      <TableCell>{new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(group.total_amount)}</TableCell>
                      <TableCell>{group.status}</TableCell>
                      <TableCell>
                        <div className="flex items-center">
                          {group.transactionCode}
                          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); copyToClipboard(group.transactionCode); }} aria-label="Copy transaction code">
                            <Copy className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>{group.codeStatus}</TableCell>
                      <TableCell>{new Date(group.created_at).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={openDialog} onOpenChange={setOpenDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Payments</DialogTitle>
          </DialogHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Amount Charged</TableHead>
                <TableHead>Amount Collected</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created At</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {selectedPayments.map((payment) => (
                <TableRow key={payment.id}>
                  <TableCell>{payment.id}</TableCell>
                  <TableCell>{new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(payment.amount_charged)}</TableCell>
                  <TableCell>{new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(payment.amount_collected)}</TableCell>
                  <TableCell>{payment.status}</TableCell>
                  <TableCell>{new Date(payment.created_at).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex justify-end mt-4">
            <Button onClick={() => setOpenDialog(false)} variant="outline" aria-label="Close dialog">
              <X className="w-4 h-4 mr-1" />
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PaymentsPage;
