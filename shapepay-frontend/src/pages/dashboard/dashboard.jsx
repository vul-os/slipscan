"use client"

import React, { useState, useEffect, useContext } from 'react';
import { supabase } from '../../services/supabaseClient';
import { AuthContext } from '../../context/use-auth';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format, subDays } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line
} from 'recharts';
import WelcomePage from './welcome';

const Dashboard = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hasData, setHasData] = useState(true);
  const [metrics, setMetrics] = useState({
    totalTransactions: 0,
    successfulTransactions: 0,
    successRate: 0,
    totalRevenue: 0,
    avgTransactionValue: 0,
    totalFees: 0,
    avgFeePerTransaction: 0
  });
  const [recentTransactions, setRecentTransactions] = useState([]);
  const [dailyRevenue, setDailyRevenue] = useState([]);
  const [topCustomers, setTopCustomers] = useState([]);
  const { user, activeMerchantId } = useContext(AuthContext);
  const [startDate, setStartDate] = useState(subDays(new Date(), 30));
  const [endDate, setEndDate] = useState(new Date());

  useEffect(() => {
    if (activeMerchantId) {
      fetchDashboardData();
    }
  }, [activeMerchantId, startDate, endDate]);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      await Promise.all([
        fetchMetrics(),
        fetchRecentTransactions(),
        fetchDailyRevenue(),
        fetchTopCustomers(),
      ]);
      setHasData(true);
    } catch (err) {
      console.error('Error fetching dashboard data:', err);
      if (err.message.includes('division by zero')) {
        setHasData(false);
      } else {
        setError('Failed to fetch dashboard data.');
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchMetrics = async () => {
    const { data, error } = await supabase.rpc('get_transaction_stats', {
      p_merchant_id: activeMerchantId,
      p_start_date: startDate.toISOString().split('T')[0],
      p_end_date: endDate.toISOString().split('T')[0]
    });

    if (error) {
      console.error('Error fetching metrics:', error);
      throw error;
    } else {
      setMetrics({
        totalTransactions: data[0]?.total_transactions || 0,
        successfulTransactions: data[0]?.successful_transactions || 0,
        successRate: data[0]?.success_rate || 0,
        totalRevenue: data[0]?.total_revenue || 0,
        avgTransactionValue: data[0]?.avg_transaction_value || 0,
        totalFees: data[0]?.total_fees || 0,
        avgFeePerTransaction: data[0]?.avg_fee_per_transaction || 0
      });
    }
  };

  const fetchRecentTransactions = async () => {
    const { data, error } = await supabase.rpc('get_recent_transactions', {
      p_merchant_id: activeMerchantId,
      p_limit_num: 5
    });

    if (error) {
      console.error('Error fetching recent transactions:', error);
      throw error;
    } else {
      setRecentTransactions(data);
    }
  };

  const fetchDailyRevenue = async () => {
    const { data, error } = await supabase.rpc('get_merchant_daily_revenue_and_payout', {
      p_merchant_id: activeMerchantId,
      p_start_date: startDate.toISOString().split('T')[0],
      p_end_date: endDate.toISOString().split('T')[0]
    });

    if (error) {
      console.error('Error fetching daily revenue:', error);
      throw error;
    } else {
      setDailyRevenue(data);
    }
  };

  const fetchTopCustomers = async () => {
    const { data, error } = await supabase.rpc('get_top_customers', {
      p_merchant_id: activeMerchantId,
      p_start_date: startDate.toISOString().split('T')[0],
      p_end_date: endDate.toISOString().split('T')[0],
      p_limit_num: 5
    });

    if (error) {
      console.error('Error fetching top customers:', error);
      throw error;
    } else {
      setTopCustomers(data);
    }
  };
  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-screen bg-gray-900">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!hasData) {
    return <WelcomePage />;
  }

  if (error) {
    return (
      <div className="p-4 bg-gray-900">
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6 bg-gray-900 text-white">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center space-y-4 sm:space-y-0">
        <h1 className="text-2xl sm:text-3xl font-bold">Dashboard</h1>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="w-full sm:w-auto justify-start text-left font-normal bg-gray-800 border-gray-700 text-white"
            >
              <CalendarIcon className="mr-2 h-4 w-4" />
              {`${format(startDate, "PPP")} - ${format(endDate, "PPP")}`}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0 bg-gray-800 border-gray-700">
            <Calendar
              mode="range"
              selected={{ from: startDate, to: endDate }}
              onSelect={({ from, to }) => {
                setStartDate(from);
                setEndDate(to || from);
              }}
              initialFocus
            />
          </PopoverContent>
        </Popover>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: "Total Transactions", value: metrics.totalTransactions },
          { title: "Total Revenue", value: `${metrics.totalRevenue.toFixed(2)} ZAR` },
          { title: "Success Rate", value: `${metrics.successRate.toFixed(2)}%` },
          { title: "Avg Transaction", value: `${metrics.avgTransactionValue.toFixed(2)} ZAR` },
        ].map((item, index) => (
          <Card key={index} className="bg-gray-800 border-gray-700">
            <CardHeader>
              <CardTitle className="text-sm sm:text-base text-gray-300">{item.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xl sm:text-2xl lg:text-3xl font-bold text-white">{item.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          { title: "Total Fees", value: `${metrics.totalFees.toFixed(2)} ZAR` },
          { title: "Avg Fee per Transaction", value: `${metrics.avgFeePerTransaction.toFixed(2)} ZAR` },
          { title: "Successful Txns", value: metrics.successfulTransactions },
        ].map((item, index) => (
          <Card key={index} className="bg-gray-800 border-gray-700">
            <CardHeader>
              <CardTitle className="text-sm sm:text-base text-gray-300">{item.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xl sm:text-2xl lg:text-3xl font-bold text-white">{item.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-100 text-xl font-bold">Daily Revenue and Payout</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] sm:h-[400px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart 
                  data={dailyRevenue}
                  margin={{ top: 20, right: 30, left: 20, bottom: 10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#4B5563" opacity={0.2} />
                  <XAxis 
                    dataKey="date" 
                    stroke="#D1D5DB" 
                    tick={{ fill: '#D1D5DB', fontSize: 12 }}
                    tickLine={{ stroke: '#6B7280' }}
                  />
                  <YAxis 
                    stroke="#D1D5DB"
                    tick={{ fill: '#D1D5DB', fontSize: 12 }}
                    tickLine={{ stroke: '#6B7280' }}
                  />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'rgba(31, 41, 55, 0.9)', 
                      border: 'none', 
                      borderRadius: '0.5rem',
                      boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)'
                    }}
                    itemStyle={{ color: '#F3F4F6', fontSize: 14 }}
                    labelStyle={{ color: '#D1D5DB', fontWeight: 'bold', fontSize: 16 }}
                    cursor={{ stroke: '#9CA3AF', strokeWidth: 2 }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="total_amount" 
                    stroke="#60A5FA" 
                    strokeWidth={3}
                    name="Total Amount" 
                    dot={{ r: 5, strokeWidth: 3, fill: '#2563EB' }}
                    activeDot={{ r: 8, strokeWidth: 0, fill: '#3B82F6' }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="payout_amount" 
                    stroke="#34D399" 
                    strokeWidth={3}
                    name="Payout Amount" 
                    dot={{ r: 5, strokeWidth: 3, fill: '#059669' }}
                    activeDot={{ r: 8, strokeWidth: 0, fill: '#10B981' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      
        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-300">Recent Transactions</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-4">
              {recentTransactions.map((txn) => (
                <li key={txn.transaction_id} className="border-b border-gray-700 pb-2">
                  <p className="font-bold text-white">{txn.amount.toFixed(2)} ZAR</p>
                  <p className="text-xs sm:text-sm text-gray-400">
                    {txn.transaction_id.slice(0, 8)} - {txn.status}
                  </p>
                  <p className="text-xs sm:text-sm text-gray-400">
                    {new Date(txn.date).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-gray-800 border-gray-700">
        <CardHeader>
          <CardTitle className="text-gray-300">Top Customers</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[250px] sm:h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topCustomers}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis 
                  dataKey="customer_name" 
                  stroke="#9CA3AF"
                  tick={{ fill: '#9CA3AF', fontSize: 10 }}
                  tickLine={{ stroke: '#4B5563' }}
                />
                <YAxis 
                  stroke="#9CA3AF"
                  tick={{ fill: '#9CA3AF', fontSize: 10 }}
                  tickLine={{ stroke: '#4B5563' }}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'rgba(17, 24, 39, 0.8)', 
                    border: 'none', 
                    borderRadius: '0.375rem',
                    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)'
                  }}
                  itemStyle={{ color: '#E5E7EB' }}
                  labelStyle={{ color: '#9CA3AF', fontWeight: 'bold' }}
                  cursor={{ fill: 'rgba(107, 114, 128, 0.1)' }}
                />
                <Bar 
                  dataKey="total_spent" 
                  fill="#3B82F6"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Dashboard;