import React, { useState, useEffect } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DateRangePicker } from '@/components/date-range-picker';
import { supabase } from '../../services/supabaseClient';
import { subDays, format } from 'date-fns';

const DashboardPage = () => {
  const [date, setDate] = useState({
    from: subDays(new Date(), 30),
    to: new Date(),
  });
  const [dailySpending, setDailySpending] = useState([]);
  const [totalSpent, setTotalSpent] = useState(0);
  const [avgDailySpend, setAvgDailySpend] = useState(0);
  const [topMerchants, setTopMerchants] = useState([]);
  const [topCategories, setTopCategories] = useState([]);
  const [recentTransactions, setRecentTransactions] = useState([]);

  useEffect(() => {
    fetchDailySpending();
    fetchTotalStats();
    fetchTopMerchants();
    fetchTopCategories();
    fetchRecentTransactions();
  }, [date]);

  const fetchDailySpending = async () => {
    const { data, error } = await supabase
      .from('extracted_items')
      .select('created_at, price')
      .gte('created_at', date.from.toISOString())
      .lte('created_at', date.to.toISOString())
      .order('created_at');

    if (error) {
      console.error('Error fetching daily spending:', error);
      return;
    }

    const aggregatedData = data.reduce((acc, curr) => {
      const day = format(new Date(curr.created_at), 'yyyy-MM-dd');
      acc[day] = (acc[day] || 0) + curr.price;
      return acc;
    }, {});

    setDailySpending(Object.entries(aggregatedData).map(([date, amount]) => ({ date, amount })));
  };

  const fetchTotalStats = async () => {
    const { data, error } = await supabase
      .from('extracted_items')
      .select('price')
      .gte('created_at', date.from.toISOString())
      .lte('created_at', date.to.toISOString());

    if (error) {
      console.error('Error fetching total stats:', error);
      return;
    }

    const total = data.reduce((sum, curr) => sum + curr.price, 0);
    setTotalSpent(total.toFixed(2));
    
    const days = Math.ceil((date.to - date.from) / (1000 * 60 * 60 * 24));
    setAvgDailySpend((total / days).toFixed(2));
  };

const fetchTopMerchants = async () => {
    const { data, error } = await supabase
      .from('document_groups')
      .select(`
        merchant_id,
        merchants (
          name
        ),
        total_amount
      `)

    if (error) {
      console.error('Error fetching top merchants:', error);
      return;
    }

    const merchantData = data.reduce((acc, curr) => {
      if (curr.merchants && curr.merchants.name) {
        const merchantName = curr.merchants.name;
        acc[merchantName] = (acc[merchantName] || 0) + (curr.total_amount || 0);
      }
      return acc;
    }, {});

    const topMerchants = Object.entries(merchantData)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    setTopMerchants(topMerchants);

    // Log the results for debugging
    console.log('Top Merchants:', topMerchants);
  };
  
  const fetchTopCategories = async () => {
    const { data, error } = await supabase
      .from('extracted_items')
      .select('category_id, categories(name), price')
      .gte('created_at', date.from.toISOString())
      .lte('created_at', date.to.toISOString());

    if (error) {
      console.error('Error fetching top categories:', error);
      return;
    }

    const categoryData = data.reduce((acc, curr) => {
      const categoryName = curr.categories?.name || 'Uncategorized';
      acc[categoryName] = (acc[categoryName] || 0) + (curr.price || 0);
      return acc;
    }, {});

    const roundedCategories = Object.entries(categoryData)
      .map(([name, amount]) => ({
        name,
        amount: Number(amount.toFixed(2))  // Round to 2 decimal places
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    setTopCategories(roundedCategories);

    // Log the results for debugging
    console.log('Top Categories:', roundedCategories);
  };

  const fetchRecentTransactions = async () => {
    const { data, error } = await supabase
      .from('extracted_items')
      .select('id, description, price, created_at')
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) {
      console.error('Error fetching recent transactions:', error);
      return;
    }

    setRecentTransactions(data);
  };

  const MetricCard = ({ title, value }) => (
    <Card className="bg-gray-800 text-white">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-gray-400">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );

  // Function to generate colors dynamically
  const generateColor = (index, total) => {
    const hue = (index / total) * 360;
    return `hsl(${hue}, 70%, 50%)`;
  };

  return (
    <div className="p-6 bg-gray-900 min-h-screen text-white">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold">Spending Insights Dashboard</h1>
          <DateRangePicker
            date={date}
            setDate={setDate}
            className="bg-gray-800 text-white"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <MetricCard title="Total Spent" value={`${totalSpent} ZAR`} />
          <MetricCard title="Avg Daily Spend" value={`${avgDailySpend} ZAR`} />
          <MetricCard title="Number of Days" value={Math.ceil((date.to - date.from) / (1000 * 60 * 60 * 24))} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="bg-gray-800">
            <CardHeader>
              <CardTitle>Daily Spending</CardTitle>
            </CardHeader>
            <CardContent className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={dailySpending}>
                  <XAxis 
                    dataKey="date" 
                    tickFormatter={(date) => format(new Date(date), 'dd/MM')}
                  />
                  <YAxis />
                  <Tooltip labelFormatter={(date) => format(new Date(date), 'yyyy-MM-dd')} />
                  <Line type="monotone" dataKey="amount" stroke="#3b82f6" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="bg-gray-800">
            <CardHeader>
              <CardTitle>Top 5 Merchants</CardTitle>
            </CardHeader>
            <CardContent className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topMerchants} layout="vertical">
                  <XAxis type="number" />
                  <YAxis dataKey="name" type="category" width={100} />
                  <Tooltip formatter={(value) => `${value.toFixed(2)} ZAR`} />
                  <Bar dataKey="amount" fill="#3b82f6" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="bg-gray-800">
            <CardHeader>
              <CardTitle>Top 5 Categories</CardTitle>
            </CardHeader>
            <CardContent className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={topCategories}
                    dataKey="amount"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    fill="#8884d8"
                    label
                  >
                    {topCategories.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={generateColor(index, topCategories.length)} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => `${value.toFixed(2)} ZAR`} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="bg-gray-800">
            <CardHeader>
              <CardTitle>Recent Transactions</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {recentTransactions.map((tx) => (
                  <li key={tx.id} className="flex justify-between items-center">
                    <span className="truncate max-w-[200px]">{tx.description}</span>
                    <span>{tx.price.toFixed(2)} ZAR</span>
                    <span className="text-sm text-gray-400">
                      {format(new Date(tx.created_at), 'dd/MM/yyyy')}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;