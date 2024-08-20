import React, { useState, useMemo } from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  getPaginationRowModel,
  getSortedRowModel,
  getFilteredRowModel,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Copy } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PaymentsTable = ({ data, filterValue, loading }) => {
  const [expandedRows, setExpandedRows] = useState({});

  const columns = useMemo(() => [
    {
      accessorKey: "external_reference_id",
      header: "External Reference ID",
      cell: ({ row }) => {
        const value = row.getValue("external_reference_id");
        return value ? value : <span className="text-gray-400 italic">Not available</span>;
      },
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
      cell: ({ row }) => {
        const status = row.getValue("status").toUpperCase();
        let statusColor = getStatusColor(status);
        return (
          <span className={`px-2 py-1 rounded-full text-xs font-semibold ${statusColor}`}>
            {status}
          </span>
        );
      },
    },
    {
      accessorKey: "code",
      header: "Payment Code",
      cell: ({ row }) => (
        <div className="flex items-center">
          {row.getValue("code")}
          {row.getValue("code") !== 'Not available' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => { e.stopPropagation(); copyToClipboard(row.getValue("code")); }}
              aria-label="Copy payment code"
              className="text-gray-300 hover:text-gray-100 hover:bg-gray-600 ml-2"
            >
              <Copy className="w-4 h-4" />
            </Button>
          )}
        </div>
      ),
    },
    {
      accessorKey: "paymentCodeStatus",
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
  ], []);

  const filteredData = useMemo(() => {
    return data.filter(item =>
      item.external_reference_id?.toLowerCase().includes(filterValue.toLowerCase()) ||
      item.status.toLowerCase().includes(filterValue.toLowerCase())
    );
  }, [data, filterValue]);

  const table = useReactTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const handleRowClick = (groupId) => {
    setExpandedRows(prev => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      console.log('Copied to clipboard');
    }, (err) => {
      console.error('Could not copy text: ', err);
    });
  };

  return (
    <Card className="mb-6 bg-gray-800 border-gray-700">
      <CardHeader className="px-0">
        <CardTitle className="text-xl text-gray-100 px-2">Payments Overview</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="rounded-md border border-gray-700">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  <TableHead className="px-2">Expand</TableHead>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} className="px-2">
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  ))}
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
                      <TableCell className="px-2">
                        {expandedRows[row.original.id] ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </TableCell>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="px-2">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                    {expandedRows[row.original.id] && (
                      <TableRow>
                        <TableCell colSpan={columns.length + 1} className="p-0">
                          <Card className="m-2 bg-gray-700 border-gray-600">
                            <CardHeader className="px-2">
                              <CardTitle className="text-gray-100">Payments for Group {row.original.id}</CardTitle>
                            </CardHeader>
                            <CardContent className="p-0">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead className="px-2">ID</TableHead>
                                    <TableHead className="px-2">Amount Charged</TableHead>
                                    <TableHead className="px-2">Status</TableHead>
                                    <TableHead className="px-2">Payment Method</TableHead>
                                    <TableHead className="px-2">Created At</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {row.original.payments.map((payment) => (
                                    <TableRow key={payment.id}>
                                      <TableCell className="px-2">{payment.id}</TableCell>
                                      <TableCell className="px-2">{new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(payment.amount_charged)}</TableCell>
                                      <TableCell className="px-2">
                                        <span className={`px-2 py-1 rounded-full text-xs font-semibold ${getStatusColor(payment.status)}`}>
                                          {payment.status.toUpperCase()}
                                        </span>
                                      </TableCell>
                                      <TableCell className="px-2">{payment.payment_method}</TableCell>
                                      <TableCell className="px-2">{new Date(payment.created_at).toLocaleString()}</TableCell>
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
                  <TableCell colSpan={columns.length + 1} className="h-24 text-center">
                    {loading ? 'Loading...' : 'No results.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-end space-x-2 py-4 px-2">
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
  );
};

const getStatusColor = (status) => {
  const uppercaseStatus = status.toUpperCase();
  switch (uppercaseStatus) {
    case 'COMPLETED':
      return 'bg-green-200 text-green-800';
    case 'PENDING':
      return 'bg-orange-200 text-orange-800';
    case 'FAILED':
      return 'bg-red-200 text-red-800';
    default:
      return 'bg-gray-200 text-gray-800';
  }
};

export default PaymentsTable;