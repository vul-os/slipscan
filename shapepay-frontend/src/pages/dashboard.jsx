"use client"

import React, { useState, useEffect, useContext } from 'react';
import { supabase } from '../services/supabaseClient';
import AuthContext from '../context/auth-context';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

const Dashboard = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [metrics, setMetrics] = useState({
    totalTransactions: 0,
    successfulTransactions: 0,
    successRate: 0,
    totalRevenue: 0,
    avgTransactionValue: 0
  });
  const [recentTransactions, setRecentTransactions] = useState([]);
  const [dailyRevenue, setDailyRevenue] = useState([]);
  const [topCustomers, setTopCustomers] = useState([]);
  const { user, merchants, activeMerchantId, setActiveMerchantId } = useContext(AuthContext);
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
    } catch (err) {
      console.error('Error fetching dashboard data:', err);
      setError('Failed to fetch dashboard data.');
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
      setError('Failed to fetch metrics.');
    } else {
      setMetrics({
        totalTransactions: data[0]?.total_transactions || 0,
        successfulTransactions: data[0]?.successful_transactions || 0,
        successRate: data[0]?.success_rate || 0,
        totalRevenue: data[0]?.total_revenue || 0,
        avgTransactionValue: data[0]?.avg_transaction_value || 0
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
      setError('Failed to fetch recent transactions.');
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
      setError('Failed to fetch daily revenue.');
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
      setError('Failed to fetch top customers.');
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
    <div className="p-6 space-y-6 bg-gray-900 text-white">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <div className="flex space-x-4">
          {merchants.length > 1 && (
            <Select value={activeMerchantId} onValueChange={setActiveMerchantId}>
              <SelectTrigger className="w-[200px] bg-gray-800 border-gray-700">
                <SelectValue placeholder="Select merchant" />
              </SelectTrigger>
              <SelectContent className="bg-gray-800 border-gray-700">
                {merchants.map((merchant) => (
                  <SelectItem key={merchant.id} value={merchant.id}>
                    {merchant.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="w-[280px] justify-start text-left font-normal bg-gray-800 border-gray-700 text-white"
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
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-300">Total Transactions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-white">{metrics.totalTransactions}</p>
          </CardContent>
        </Card>
        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-300">Total Revenue</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-white">{metrics.totalRevenue.toFixed(2)} ZAR</p>
          </CardContent>
        </Card>
        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-300">Success Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-white">{metrics.successRate.toFixed(2)}%</p>
          </CardContent>
        </Card>
        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-300">Avg Transaction</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-white">{metrics.avgTransactionValue.toFixed(2)} ZAR</p>
          </CardContent>
        </Card>
        <Card className="bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-300">Successful Txns</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-white">{metrics.successfulTransactions}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-gray-300">Daily Revenue and Payout</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[400px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={dailyRevenue}
                  margin={{ top: 20, right: 30, left: 20, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" opacity={0.1} />
                  <XAxis 
                    dataKey="date" 
                    stroke="#9CA3AF" 
                    tick={{ fill: '#9CA3AF', fontSize: 12 }}
                    tickLine={{ stroke: '#4B5563' }}
                  />
                  <YAxis 
                    stroke="#9CA3AF"
                    tick={{ fill: '#9CA3AF', fontSize: 12 }}
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
                    cursor={{ stroke: '#6B7280', strokeWidth: 1 }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="total_amount" 
                    stroke="#3B82F6" 
                    strokeWidth={3}
                    name="Total Amount" 
                    dot={{ r: 4, strokeWidth: 2, fill: '#1E3A8A' }}
                    activeDot={{ r: 8, strokeWidth: 0, fill: '#60A5FA' }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="payout_amount" 
                    stroke="#10B981" 
                    strokeWidth={3}
                    name="Payout Amount" 
                    dot={{ r: 4, strokeWidth: 2, fill: '#065F46' }}
                    activeDot={{ r: 8, strokeWidth: 0, fill: '#34D399' }}
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
                  <p className="text-sm text-gray-400">
                    {txn.transaction_id.slice(0, 8)} - {txn.status}
                  </p>
                  <p className="text-sm text-gray-400">
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
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topCustomers}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="customer_name" stroke="#9CA3AF" />
                <YAxis stroke="#9CA3AF" />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#1F2937', border: 'none', borderRadius: '0.375rem' }}
                  itemStyle={{ color: '#E5E7EB' }}
                  labelStyle={{ color: '#9CA3AF' }}
                />
                <Bar dataKey="total_spent" fill="#3B82F6" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Dashboard;