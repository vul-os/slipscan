import React, { useState, useEffect } from 'react';
import { supabase } from '../../services/supabaseClient';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Home, CreditCard as Payment, Copy, ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import CreatePaymentForm from './create-payments';

const PaymentsPage = () => {
  const [paymentGroups, setPaymentGroups] = useState([]);
  const [expandedGroupId, setExpandedGroupId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isCreatePaymentOpen, setIsCreatePaymentOpen] = useState(false);

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
        codeStatus: group.transaction_codes?.[0]?.status || 'N/A',
        payments: []
      })));
    } catch (error) {
      console.error('Error fetching payment groups:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRowClick = async (groupId) => {
    if (expandedGroupId === groupId) {
      setExpandedGroupId(null);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('payments')
        .select('*')
        .eq('payment_group_id', groupId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      setPaymentGroups(prevGroups =>
        prevGroups.map(group =>
          group.id === groupId ? { ...group, payments: data } : group
        )
      );
      setExpandedGroupId(groupId);
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

  const handleCreatePayment = async (newPayment) => {
    try {
      const { data, error } = await supabase
        .from('payments')
        .insert([
          {
            amount_charged: parseFloat(newPayment.amount),
            amount_collected: parseFloat(newPayment.amount),
            description: newPayment.description,
            status: 'completed',
            txn_id: `POS_${Date.now()}`
          }
        ]);

      if (error) throw error;

      console.log('Payment created:', data);
      setIsCreatePaymentOpen(false);
      fetchPaymentGroups(); // Refresh the payment groups
    } catch (error) {
      console.error('Error creating payment:', error);
    }
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
              <Payment className="w-4 h-4 mr-1" />
              Payments
            </span>
          </div>
          <Button onClick={() => setIsCreatePaymentOpen(true)} className="bg-blue-500 hover:bg-blue-600">
            <Plus className="w-4 h-4 mr-2" /> New Payment
          </Button>
        </div>

        <Card className="mb-6 bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-100">Payments Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-300">This page displays all payment groups and their associated transaction codes. Click on a row to view individual payments within that group.</p>
          </CardContent>
        </Card>

        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-100">Payment Groups</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex justify-center items-center h-40">
                <p className="text-gray-300">Loading...</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-b border-gray-700">
                      <TableHead className="hidden md:table-cell text-gray-300">ID</TableHead>
                      <TableHead className="text-gray-300">Transaction ID</TableHead>
                      <TableHead className="hidden md:table-cell text-gray-300">External Reference ID</TableHead>
                      <TableHead className="text-gray-300">Total Amount</TableHead>
                      <TableHead className="hidden md:table-cell text-gray-300">Status</TableHead>
                      <TableHead className="text-gray-300">Transaction Code</TableHead>
                      <TableHead className="hidden md:table-cell text-gray-300">Code Status</TableHead>
                      <TableHead className="hidden md:table-cell text-gray-300">Created At</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paymentGroups.map((group) => (
                      <React.Fragment key={group.id}>
                        <TableRow 
                          onClick={() => handleRowClick(group.id)} 
                          className="cursor-pointer hover:bg-gray-700 border-b border-gray-700 transition-colors duration-150"
                        >
                          <TableCell className="hidden md:table-cell">{group.id}</TableCell>
                          <TableCell>{group.txn_id}</TableCell>
                          <TableCell className="hidden md:table-cell">{group.external_reference_id || 'N/A'}</TableCell>
                          <TableCell>{new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(group.total_amount)}</TableCell>
                          <TableCell className="hidden md:table-cell">{group.status}</TableCell>
                          <TableCell>
                            <div className="flex items-center">
                              {group.transactionCode}
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                onClick={(e) => { e.stopPropagation(); copyToClipboard(group.transactionCode); }} 
                                aria-label="Copy transaction code"
                                className="text-gray-300 hover:text-gray-100 hover:bg-gray-600"
                              >
                                <Copy className="w-4 h-4" />
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">{group.codeStatus}</TableCell>
                          <TableCell className="hidden md:table-cell">{new Date(group.created_at).toLocaleString()}</TableCell>
                          <TableCell>
                            {expandedGroupId === group.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </TableCell>
                        </TableRow>
                        {expandedGroupId === group.id && (
                          <TableRow>
                            <TableCell colSpan="9" className="p-0">
                              <Card className="m-2 bg-gray-700 border-gray-600">
                                <CardHeader>
                                  <CardTitle className="text-gray-100">Payments for Group {group.id}</CardTitle>
                                </CardHeader>
                                <CardContent>
                                  <div className="overflow-x-auto">
                                    <Table>
                                      <TableHeader>
                                        <TableRow className="border-b border-gray-600">
                                          <TableHead className="text-gray-300">ID</TableHead>
                                          <TableHead className="text-gray-300">Amount Charged</TableHead>
                                          <TableHead className="text-gray-300">Amount Collected</TableHead>
                                          <TableHead className="text-gray-300">Status</TableHead>
                                          <TableHead className="text-gray-300">Created At</TableHead>
                                        </TableRow>
                                      </TableHeader>
                                      <TableBody>
                                        {group.payments.map((payment) => (
                                          <TableRow 
                                            key={payment.id} 
                                            className="border-b border-gray-600 hover:bg-gray-600 transition-colors duration-150"
                                          >
                                            <TableCell>{payment.id}</TableCell>
                                            <TableCell>{new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(payment.amount_charged)}</TableCell>
                                            <TableCell>{new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(payment.amount_collected)}</TableCell>
                                            <TableCell>{payment.status}</TableCell>
                                            <TableCell>{new Date(payment.created_at).toLocaleString()}</TableCell>
                                          </TableRow>
                                        ))}
                                      </TableBody>
                                    </Table>
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

        <CreatePaymentForm
          isOpen={isCreatePaymentOpen}
          onClose={() => setIsCreatePaymentOpen(false)}
          onSubmit={handleCreatePayment}
        />
      </div>
    </div>
  );
};

export default PaymentsPage;