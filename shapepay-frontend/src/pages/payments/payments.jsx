import React, { useState, useEffect } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  getPaginationRowModel,
  getSortedRowModel,
  getFilteredRowModel,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Copy, Plus } from 'lucide-react';
import { supabase } from '../../services/supabaseClient';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import CreatePaymentForm from './create-payment';

const PaymentsPage = () => {
  const [data, setData] = useState([]);
  const [expandedRows, setExpandedRows] = useState({});
  const [loading, setLoading] = useState(true);
  const [isCreatePaymentOpen, setIsCreatePaymentOpen] = useState(false);

  useEffect(() => {
    fetchPaymentGroupsWithCodes();
  }, []);

  const fetchPaymentGroupsWithCodes = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('payment_groups')
        .select(`
          id,
          txn_id,
          external_reference_id,
          total_amount,
          status,
          created_at,
          updated_at,
          transaction_codes (
            code,
            status,
            expires_at
          )
        `)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const processedData = data.map((group) => {
        const { transaction_codes, ...rest } = group;
        const flattenedTransactionCode = transaction_codes?.[0] || {};
        return {
          ...rest,
          code: flattenedTransactionCode.code || 'Not available',
          transactionCodeStatus: flattenedTransactionCode.status || 'Not available',
          codeExpiry: flattenedTransactionCode.expires_at || null,
          payments: [],
        };
      });

      setData(processedData);
    } catch (error) {
      console.error('Error fetching payment groups with codes:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRowClick = async (groupId) => {
    setExpandedRows(prev => ({ ...prev, [groupId]: !prev[groupId] }));
    if (!expandedRows[groupId]) {
      try {
        const { data: payments, error } = await supabase
          .from('payments')
          .select('*')
          .eq('payment_group_id', groupId)
          .order('created_at', { ascending: false });

        if (error) throw error;

        setData(prevData =>
          prevData.map(group =>
            group.id === groupId ? { ...group, payments } : group
          )
        );
      } catch (error) {
        console.error('Error fetching payments:', error);
      }
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
      fetchPaymentGroupsWithCodes();
    } catch (error) {
      console.error('Error creating payment:', error);
    }
  };

  const columns = [
    {
      accessorKey: "txn_id",
      header: "Transaction ID",
    },
    {
      accessorKey: "external_reference_id",
      header: "External Reference ID",
    },
    {
      accessorKey: "total_amount",
      header: "Total Amount",
      cell: ({ row }) => {
        const amount = parseFloat(row.getValue("total_amount"));
        const formatted = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
        return <div className="text-right font-medium">{formatted}</div>;
      },
    },
    {
      accessorKey: "status",
      header: "Status",
    },
    {
      accessorKey: "code",
      header: "Transaction Code",
      cell: ({ row }) => (
        <div className="flex items-center">
          {row.getValue("code")}
          {row.getValue("code") !== 'Not available' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => { e.stopPropagation(); copyToClipboard(row.getValue("code")); }}
              aria-label="Copy transaction code"
              className="text-gray-300 hover:text-gray-100 hover:bg-gray-600 ml-2"
            >
              <Copy className="w-4 h-4" />
            </Button>
          )}
        </div>
      ),
    },
    {
      accessorKey: "transactionCodeStatus",
      header: "Code Status",
    },
    {
      accessorKey: "codeExpiry",
      header: "Code Expiry",
      cell: ({ row }) => {
        const expiry = row.getValue("codeExpiry");
        return expiry ? new Date(expiry).toLocaleString() : 'N/A';
      },
    },
    {
      accessorKey: "created_at",
      header: "Created At",
      cell: ({ row }) => new Date(row.getValue("created_at")).toLocaleString(),
    },
  ];

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="container mx-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Payments</h1>
        <Button onClick={() => setIsCreatePaymentOpen(true)} className="bg-blue-500 hover:bg-blue-600">
          <Plus className="w-4 h-4 mr-2" /> New Payment
        </Button>
      </div>

      <Card className="mb-6 bg-gray-800 border-gray-700">
        <CardHeader>
          <CardTitle className="text-gray-100">Payments Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center py-4">
            <Input
              placeholder="Filter emails..."
              value={(table.getColumn("email")?.getFilterValue()) ?? ""}
              onChange={(event) =>
                table.getColumn("email")?.setFilterValue(event.target.value)
              }
              className="max-w-sm"
            />
          </div>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    <TableHead>Expand</TableHead>
                    {headerGroup.headers.map((header) => {
                      return (
                        <TableHead key={header.id}>
                          {header.isPlaceholder
                            ? null
                            : flexRender(
                                header.column.columnDef.header,
                                header.getContext()
                              )}
                        </TableHead>
                      )
                    })}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows?.length ? (
                  table.getRowModel().rows.map((row) => (
                    <React.Fragment key={row.id}>
                      <TableRow
                        data-state={row.getIsSelected() && "selected"}
                        onClick={() => handleRowClick(row.original.id)}
                        className="cursor-pointer hover:bg-gray-700 transition-colors duration-150"
                      >
                        <TableCell>
                          {expandedRows[row.original.id] ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </TableCell>
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </TableRow>
                      {expandedRows[row.original.id] && (
                        <TableRow>
                          <TableCell colSpan={columns.length + 1}>
                            <Card className="m-2 bg-gray-700 border-gray-600">
                              <CardHeader>
                                <CardTitle className="text-gray-100">Payments for Group {row.original.id}</CardTitle>
                              </CardHeader>
                              <CardContent>
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
                                    {row.original.payments.map((payment) => (
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
                              </CardContent>
                            </Card>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={columns.length} className="h-24 text-center">
                      No results.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-end space-x-2 py-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      <CreatePaymentForm
        isOpen={isCreatePaymentOpen}
        onClose={() => setIsCreatePaymentOpen(false)}
        onSubmit={handleCreatePayment}
      />
    </div>
  );
};

export default PaymentsPage