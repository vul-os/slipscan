import React, { useState, useEffect } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Pie, Cell } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DateRangePicker } from '@/components/date-range-picker';
import { supabase } from '../../services/supabaseClient';
import { subDays, format } from 'date-fns';
import { AlertCircle, Receipt, BarChart2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import CustomPieChart from './custom-pie-chart';

const DashboardPage = () => {
  const navigate = useNavigate();
  const [date, setDate] = useState({
    from: subDays(new Date(), 30),
    to: new Date(),
  });
  const [dailySpending, setDailySpending] = useState([]);
  const [totalSpent, setTotalSpent] = useState(0);
  const [avgDailySpend, setAvgDailySpend] = useState(0);
  const [avgSlipSpend, setAvgSlipSpend] = useState(0);
  const [totalTax, setTotalTax] = useState(0); 
  const [topMerchants, setTopMerchants] = useState([]);
  const [categories, setCategories] = useState([]);
  const [recentTransactions, setRecentTransactions] = useState([]);
  const [hasData, setHasData] = useState(false);

  useEffect(() => {
    fetchDailySpending();
    fetchTotalStats();
    fetchTopMerchants();
    fetchCategories();
    fetchRecentTransactions();
    fetchTotalTax();
  }, [date]);

  const fetchDailySpending = async () => {
    const { data, error } = await supabase
      .from('document_groups')
      .select('document_timestamp, total_amount')
      .gte('document_timestamp', date.from.toISOString())
      .lte('document_timestamp', date.to.toISOString())
      .order('document_timestamp');
  
    if (error) {
      console.error('Error fetching daily spending:', error);
      return;
    }
  
    if (data && data.length > 0) {
      setHasData(true);
      const aggregatedData = data.reduce((acc, curr) => {
        const day = format(new Date(curr.document_timestamp), 'yyyy-MM-dd');
        acc[day] = (acc[day] || 0) + (curr.total_amount || 0);
        return acc;
      }, {});
  
      setDailySpending(Object.entries(aggregatedData).map(([date, amount]) => ({ date, amount })));
    } else {
      setHasData(false);
      setDailySpending([]);
    }
  };

  const fetchTotalStats = async () => {
    const { data, error } = await supabase
      .from('extracted_items')
      .select('price')

    if (error) {
      console.error('Error fetching total stats:', error);
      return;
    }

    const total = data.reduce((sum, curr) => sum + curr.price, 0);
    setTotalSpent(total.toFixed(2));
    
    const days = Math.ceil((date.to - date.from) / (1000 * 60 * 60 * 24));
    setAvgDailySpend((total / days).toFixed(2));
    setAvgSlipSpend((total / data.length).toFixed(2));
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
  };
  
  const fetchTotalTax = async () => {
    const { data, error } = await supabase
      .from('document_groups')
      .select('tax_amount')
    if (error) {
      console.error('Error fetching total tax:', error);
      return;
    }

    const total = data.reduce((sum, curr) => sum + (curr.tax_amount || 0), 0);
    setTotalTax(total.toFixed(2));
  };

  const fetchCategories = async () => {
    const { data, error } = await supabase
      .from('extracted_items')
      .select('category_id, categories(name), price')


    if (error) {
      console.error('Error fetching categories:', error);
      return;
    }

    const categoryData = data.reduce((acc, curr) => {
      const categoryName = curr.categories?.name || 'Uncategorized';
      acc[categoryName] = (acc[categoryName] || 0) + (curr.price || 0);
      return acc;
    }, {});

    const total = Object.values(categoryData).reduce((sum, amount) => sum + amount, 0);

    let otherAmount = 0;
    const groupedCategories = Object.entries(categoryData)
      .map(([name, amount]) => ({
        name,
        amount: Number(amount.toFixed(2)),
        percentage: (amount / total) * 100
      }))
      .sort((a, b) => b.amount - a.amount)
      .reduce((acc, category) => {
        if (category.percentage >= 2) {
          acc.push(category);
        } else {
          otherAmount += category.amount;
        }
        return acc;
      }, []);

    if (otherAmount > 0) {
      groupedCategories.push({
        name: 'Other',
        amount: Number(otherAmount.toFixed(2)),
        percentage: (otherAmount / total) * 100
      });
    }

    setCategories(groupedCategories);
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

  const OnboardingMessage = () => {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-2 sm:px-4 py-6 sm:py-8 max-w-4xl mx-auto">
        <h2 className="text-2xl sm:text-3xl font-bold mb-4">Welcome to Your Spending Insights Dashboard!</h2>
        <p className="text-lg sm:text-xl mb-6">Let's get started on your journey to better financial awareness.</p>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-8 mb-8 w-full">
          <Card className="bg-gray-800 p-3 sm:p-4 md:p-6">
            <Receipt className="w-10 h-10 md:w-12 md:h-12 text-blue-400 mx-auto mb-3 md:mb-4" />
            <h3 className="text-lg font-semibold mb-2">1. Upload Your Slips</h3>
            <p className="text-sm md:text-base">Start by uploading your receipts and bills to build your spending history.</p>
          </Card>
          
          <Card className="bg-gray-800 p-3 sm:p-4 md:p-6">
            <BarChart2 className="w-10 h-10 md:w-12 md:h-12 text-green-400 mx-auto mb-3 md:mb-4" />
            <h3 className="text-lg font-semibold mb-2">2. Process Your Data</h3>
            <p className="text-sm md:text-base">We'll analyze your uploads to generate insightful spending patterns.</p>
          </Card>
          
          <Card className="bg-gray-800 p-3 sm:p-4 md:p-6">
            <AlertCircle className="w-10 h-10 md:w-12 md:h-12 text-yellow-400 mx-auto mb-3 md:mb-4" />
            <h3 className="text-lg font-semibold mb-2">3. Gain Insights</h3>
            <p className="text-sm md:text-base">Explore your spending habits and make informed financial decisions.</p>
          </Card>
        </div>
        
        <Button 
          variant="default" 
          size="lg"
          onClick={() => navigate('/slips')}
          className="w-full sm:w-auto bg-blue-500 hover:bg-blue-600 text-white font-bold py-3 px-6 rounded-lg transition duration-300"
        >
          Get Started: Go to Slips
        </Button>
        
        <p className="mt-6 text-sm md:text-base text-gray-400">
          Once you've uploaded and processed your slips, return here to see your personalized spending insights!
        </p>
      </div>
    );
  };
  
  const generateBlueShades = (count) => {
    const baseHue = 210; // Blue hue
    const shades = [];
    for (let i = 0; i < count; i++) {
      const lightness = 25 + (i * 50) / count; // Vary lightness from 25% to 75%
      shades.push(`hsl(${baseHue}, 70%, ${lightness}%)`);
    }
    return shades;
  };

  if (!hasData) {
    return (
      <Card className="bg-gray-800 p-4 sm:p-8">
        <OnboardingMessage />
      </Card>
    )
  }

  return (
    <div className="p-2 sm:p-4 md:p-6 bg-gray-900 min-h-screen text-white">
      <div className="max-w-7xl mx-auto space-y-4 sm:space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center">
          <h1 className="text-2xl sm:text-3xl font-bold mb-2 sm:mb-0">Spending Insights Dashboard</h1>
          <DateRangePicker
            date={date}
            setDate={setDate}
            className="bg-gray-800 text-white w-full sm:w-auto mt-2 sm:mt-0"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard title="Total Spent" value={`R ${totalSpent}`} />
          <MetricCard title="Avg Daily Spend" value={`R ${avgDailySpend}`} />
          <MetricCard title="Avg Item Spend" value={`R ${avgSlipSpend}`} />
          <MetricCard title="Total Tax" value={`R ${totalTax}`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="bg-gray-800">
          <CardHeader>
            <CardTitle>Daily Spending</CardTitle>
          </CardHeader>
          <CardContent className="h-72 sm:h-96">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dailySpending} margin={{ top: 20, right: 30, left: 20, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#444" />
                <XAxis 
                  dataKey="date" 
                  tickFormatter={(date) => format(new Date(date), 'dd/MM')}
                  stroke="#888"
                />
                <YAxis 
                  stroke="#888"
                  tickFormatter={(value) => `R ${value}`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1f2937',
                    border: '1px solid #374151',
                    borderRadius: '0.5rem',
                    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
                  }}
                  itemStyle={{ color: '#60a5fa' }}
                  formatter={(value) => [`R ${value.toFixed(2)}`, 'Amount']}
                  labelFormatter={(label) => format(new Date(label), 'MMMM d, yyyy')}
                />
                <Line 
                  type="monotone" 
                  dataKey="amount" 
                  stroke="#3b82f6" 
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 8, fill: "#3b82f6", stroke: "#fff" }}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

          <Card className="bg-gray-800">
            <CardHeader>
              <CardTitle>Top 5 Merchants</CardTitle>
            </CardHeader>
            <CardContent className="h-60 sm:h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topMerchants} layout="vertical">
                  <XAxis type="number" />
                  <YAxis dataKey="name" type="category" width={100} />
                  <Tooltip formatter={(value) => `${value.toFixed(2)} ZAR`} />
                  <Bar dataKey="amount">
                    {topMerchants.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={generateBlueShades(topMerchants.length)[index]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="bg-gray-800">
            <CardHeader>
              <CardTitle>Categories</CardTitle>
            </CardHeader>
            <CardContent className="h-80 sm:h-96">
              <CustomPieChart data={categories} generateBlueShades={generateBlueShades} />
            </CardContent>
          </Card>

          <Card className="bg-gray-800">
            <CardHeader>
              <CardTitle>Recent Transactions</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-4">
                {recentTransactions.map((tx) => (
                  <li key={tx.id} className="bg-gray-700 rounded-lg p-3 shadow-md">
                    <div className="flex justify-between items-center">
                      <span className="font-medium truncate max-w-[200px]">{tx.description}</span>
                      <span className="text-blue-300 font-bold">{tx.price.toFixed(2)} ZAR</span>
                    </div>
                    <div className="text-sm text-gray-400 mt-1">
                      {format(new Date(tx.created_at), 'dd MMMM yyyy')}
                    </div>
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
