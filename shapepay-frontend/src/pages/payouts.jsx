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
import { CalendarIcon, Search } from 'lucide-react';
import { supabase } from '../services/supabaseClient';
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
import { AuthContext } from '../context/use-auth';

const PayoutsPage = () => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const { activeMerchantId } = useContext(AuthContext);
  const [dateRange, setDateRange] = useState({
    from: addDays(new Date(), -30),
    to: new Date(),
  });
  const [filterValue, setFilterValue] = useState("");

  useEffect(() => {
    if (dateRange?.from && dateRange?.to) {
      fetchPayouts();
    }
  }, [activeMerchantId, dateRange]);

  const fetchPayouts = async () => {
    if (!dateRange?.from || !dateRange?.to) return;

    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('payouts')
        .select('*')
        .eq('merchant_id', activeMerchantId)
        .gte('created_at', dateRange.from.toISOString())
        .lte('created_at', dateRange.to.toISOString())
        .order('created_at', { ascending: false });

      if (error) throw error;

      setData(data);
    } catch (error) {
      console.error('Error fetching payouts:', error);
    } finally {
      setLoading(false);
    }
  };

  const filteredData = useMemo(() => {
    return data.filter(item =>
      item.status.toLowerCase().includes(filterValue.toLowerCase())
    );
  }, [data, filterValue]);

  const stats = useMemo(() => {
    const totalPayouts = filteredData.length;
    const totalAmount = filteredData.reduce((sum, payout) => sum + parseFloat(payout.amount), 0);
    const completedPayouts = filteredData.filter(payout => payout.status === 'completed').length;
    const pendingPayouts = filteredData.filter(payout => payout.status === 'pending').length;

    return {
      totalPayouts,
      totalAmount,
      completedPayouts,
      pendingPayouts,
      avgPayoutValue: totalPayouts > 0 ? totalAmount / totalPayouts : 0,
    };
  }, [filteredData]);

  const columns = [
    {
      accessorKey: "id",
      header: "Payout ID",
    },
    {
      accessorKey: "amount",
      header: "Amount",
      cell: ({ row }) => {
        const amount = parseFloat(row.getValue("amount"));
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
      accessorKey: "payout_date",
      header: "Payout Date",
      cell: ({ row }) => row.getValue("payout_date") ? new Date(row.getValue("payout_date")).toLocaleString() : 'N/A',
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
      <h1 className="text-3xl font-bold mb-6">Payouts</h1>

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
                placeholder="Filter payouts..."
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
          <CardTitle className="text-xl text-gray-100">Payout Statistics</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <StatCard title="Total Payouts" value={stats.totalPayouts} />
            <StatCard title="Total Amount" value={new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(stats.totalAmount)} />
            <StatCard title="Completed Payouts" value={stats.completedPayouts} />
            <StatCard title="Pending Payouts" value={stats.pendingPayouts} />
            <StatCard title="Avg Payout Value" value={new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(stats.avgPayoutValue)} />
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6 bg-gray-800 border-gray-700">
        <CardHeader>
          <CardTitle className="text-xl text-gray-100">Payouts Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-gray-700">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
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
                    <TableRow
                      key={row.id}
                      data-state={row.getIsSelected() && "selected"}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
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
    </div>
  );
};

const StatCard = ({ title, value }) => (
  <div className="p-4 bg-gray-700 rounded-lg">
    <h3 className="text-lg font-semibold text-gray-300">{title}</h3>
    <p className="text-2xl font-bold text-white">{value}</p>
  </div>
);

export default PayoutsPage;