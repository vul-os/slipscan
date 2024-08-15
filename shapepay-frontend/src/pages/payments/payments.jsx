import React, { useState, useEffect, useContext, useMemo } from 'react';
import { addDays, format } from "date-fns";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  getPaginationRowModel,
  getSortedRowModel,
  getFilteredRowModel,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Copy, Plus, CalendarIcon, Search } from 'lucide-react';
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
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import CreatePaymentForm from './create-payment';
import AuthContext from '../../context/auth-context';

const PaymentsPage = () => {
  const [data, setData] = useState([]);
  const [expandedRows, setExpandedRows] = useState({});
  const [loading, setLoading] = useState(true);
  const [isCreatePaymentOpen, setIsCreatePaymentOpen] = useState(false);
  const { activeMerchantId } = useContext(AuthContext);
  const [dateRange, setDateRange] = useState({
    from: addDays(new Date(), -30),
    to: new Date(),
  });
  const [filterValue, setFilterValue] = useState("");

  useEffect(() => {
    if (dateRange?.from && dateRange?.to) {
      fetchPaymentGroups();
    }
  }, [activeMerchantId, dateRange]);

  const fetchPaymentGroups = async () => {
    if (!dateRange?.from || !dateRange?.to) return;

    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('payment_groups')
        .select(`
          id,
          external_reference_id,
          total_amount,
          status,
          created_at,
          updated_at,
          payments (
            id,
            amount_charged,
            status,
            payment_method,
            created_at,
            payment_codes (
              payment_code_definitions (
                code,
                status,
                expires_at
              )
            )
          )
        `)
        .order('created_at', { ascending: false })
        .filter('merchant_id', 'eq', activeMerchantId)
        .gte('created_at', dateRange.from.toISOString())
        .lte('created_at', dateRange.to.toISOString());
  
      if (error) throw error;
  
      const processedData = data.map((group) => {
        const payment = group.payments[0];
        const paymentCode = payment?.payment_codes[0]?.payment_code_definitions;
        return {
          ...group,
          code: paymentCode?.code || 'Not available',
          paymentCodeStatus: paymentCode?.status || 'Not available',
          codeExpiry: paymentCode?.expires_at || null,
        };
      });
  
      setData(processedData);
    } catch (error) {
      console.error('Error fetching payment groups:', error);
    } finally {
      setLoading(false);
    }
  };

  const filteredData = useMemo(() => {
    return data.filter(item =>
      item.external_reference_id.toLowerCase().includes(filterValue.toLowerCase()) ||
      item.status.toLowerCase().includes(filterValue.toLowerCase())
    );
  }, [data, filterValue]);

  const stats = useMemo(() => {
    const totalPayments = filteredData.length;
    const totalAmount = filteredData.reduce((sum, group) => sum + parseFloat(group.total_amount), 0);
    const completedPayments = filteredData.filter(group => group.status === 'completed').length;
    const pendingPayments = filteredData.filter(group => group.status === 'pending').length;

    return {
      totalPayments,
      totalAmount,
      completedPayments,
      pendingPayments,
      avgTransactionValue: totalPayments > 0 ? totalAmount / totalPayments : 0,
    };
  }, [filteredData]);

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

  const handleCreatePayment = async (newPayment) => {
    // Implementation for creating a new payment
  };

  const columns = [
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
      cell: ({ row }) => {
        const status = row.getValue("status").toUpperCase();
        let statusColor = "bg-gray-200 text-gray-800";
        if (status === "COMPLETED") statusColor = "bg-green-200 text-green-800";
        if (status === "PENDING") statusColor = "bg-orange-200 text-orange-800";
        if (status === "FAILED") statusColor = "bg-red-200 text-red-800";
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
  ];

  const table = useReactTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="container mx-auto p-4 bg-gray-900 text-white">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Payments</h1>
        <Button onClick={() => setIsCreatePaymentOpen(true)} className="bg-blue-500 hover:bg-blue-600">
          <Plus className="w-4 h-4 mr-2" /> New Payment
        </Button>
      </div>

      <Card className="mb-6 bg-gray-800 border-gray-700">
        <CardHeader>
          <CardTitle className="text-xl text-gray-100">Filters and Date Range</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row items-center space-y-4 md:space-y-0 md:space-x-4">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  id="date"
                  variant={"outline"}
                  className={cn(
                    "w-[300px] justify-start text-left font-normal",
                    !dateRange && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {dateRange?.from ? (
                    dateRange.to ? (
                      <>
                        {format(dateRange.from, "LLL dd, y")} -{" "}
                        {format(dateRange.to, "LLL dd, y")}
                      </>
                    ) : (
                      format(dateRange.from, "LLL dd, y")
                    )
                  ) : (
                    <span>Pick a date range</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  initialFocus
                  mode="range"
                  defaultMonth={dateRange?.from}
                  selected={dateRange}
                  onSelect={setDateRange}
                  numberOfMonths={2}
                />
              </PopoverContent>
            </Popover>
            <div className="relative w-full md:w-64">
              <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
              <Input
                placeholder="Filter payments..."
                value={filterValue}
                onChange={(e) => setFilterValue(e.target.value)}
                className="pl-10 w-full"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6 bg-gray-800 border-gray-700">
        <CardHeader>
          <CardTitle className="text-xl text-gray-100">Payment Statistics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <StatCard title="Total Payments" value={stats.totalPayments} />
            <StatCard title="Total Amount" value={new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(stats.totalAmount)} />
            <StatCard title="Completed Payments" value={stats.completedPayments} />
            <StatCard title="Pending Payments" value={stats.pendingPayments} />
            <StatCard title="Avg Transaction Value" value={new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(stats.avgTransactionValue)} />
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6 bg-gray-800 border-gray-700">
        <CardHeader>
          <CardTitle className="text-xl text-gray-100">Payments Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-gray-700">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    <TableHead>Expand</TableHead>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
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
                                      <TableHead>Status</TableHead>
                                      <TableHead>Payment Method</TableHead>
                                      <TableHead>Created At</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {row.original.payments.map((payment) => (
                                      <TableRow key={payment.id}>
                                        <TableCell>{payment.id}</TableCell>
                                        <TableCell>{new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(payment.amount_charged)}</TableCell>
                                        <TableCell>
                                          <span className={`px-2 py-1 rounded-full text-xs font-semibold ${getStatusColor(payment.status)}`}>
                                            {payment.status.toUpperCase()}
                                          </span>
                                        </TableCell>
                                        <TableCell>{payment.payment_method}</TableCell>
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

const StatCard = ({ title, value }) => (
  <div className="p-4 bg-gray-700 rounded-lg">
    <h3 className="text-lg font-semibold text-gray-300">{title}</h3>
    <p className="text-2xl font-bold text-white">{value}</p>
  </div>
);

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

export default PaymentsPage;

