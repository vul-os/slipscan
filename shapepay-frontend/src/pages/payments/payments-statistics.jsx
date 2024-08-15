import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const StatCard = ({ title, value }) => (
  <div className="p-4 bg-gray-700 rounded-lg">
    <h3 className="text-lg font-semibold text-gray-300">{title}</h3>
    <p className="text-2xl font-bold text-white">{value}</p>
  </div>
);

const PaymentStatistics = ({ data, filterValue }) => {
  const stats = useMemo(() => {
    const filteredData = data.filter(item =>
      item.external_reference_id.toLowerCase().includes(filterValue.toLowerCase()) ||
      item.status.toLowerCase().includes(filterValue.toLowerCase())
    );

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
  }, [data, filterValue]);

  return (
    <Card className="mb-6 bg-gray-800 border-gray-700">
      <CardHeader>
        <CardTitle className="text-xl text-gray-100">Payment Statistics</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard 
            title="Total Payments" 
            value={stats.totalPayments.toLocaleString()} 
          />
          <StatCard 
            title="Total Amount" 
            value={new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(stats.totalAmount)} 
          />
          <StatCard 
            title="Completed Payments" 
            value={stats.completedPayments.toLocaleString()} 
          />
          <StatCard 
            title="Pending Payments" 
            value={stats.pendingPayments.toLocaleString()} 
          />
          <StatCard 
            title="Avg Transaction Value" 
            value={new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(stats.avgTransactionValue)} 
          />
        </div>
      </CardContent>
    </Card>
  );
};

export default PaymentStatistics;