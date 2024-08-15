import React, { useState, useEffect, useContext } from 'react';
import { addDays } from "date-fns";
import { Plus } from 'lucide-react';
import { supabase } from '../../services/supabaseClient';
import { Button } from "@/components/ui/button";
import AuthContext from '../../context/auth-context';
import PaymentFilters from './payments-filters';
import PaymentStatistics from './payments-statistics';
import PaymentsTable from './payments-table';
import CreatePaymentForm from './create-payment';

const PaymentsPage = () => {
  const [data, setData] = useState([]);
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
      // Here you might want to set an error state and display it to the user
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePayment = async (newPayment) => {
    // try {
    //   // Implementation for creating a new payment
    //   // This is a placeholder and should be replaced with actual logic
    //   console.log('Creating new payment:', newPayment);
      
    //   // After successfully creating the payment, you might want to:
    //   // 1. Close the create payment form
    //   setIsCreatePaymentOpen(false);
    //   // 2. Refresh the payment data
    //   await fetchPaymentGroups();
    //   // 3. Show a success message to the user
    //   // You might want to implement a toast or notification system for this
    // } catch (error) {
    //   console.error('Error creating payment:', error);
    //   // Handle the error, perhaps by showing an error message to the user
    // }
  };

  return (
    <div className="container mx-auto p-4 bg-gray-900 text-white">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Payments</h1>
        <Button onClick={() => setIsCreatePaymentOpen(true)} className="bg-blue-500 hover:bg-blue-600">
          <Plus className="w-4 h-4 mr-2" /> New Payment
        </Button>
      </div>

      <PaymentFilters 
        dateRange={dateRange} 
        setDateRange={setDateRange}
        filterValue={filterValue}
        setFilterValue={setFilterValue}
      />

      <PaymentStatistics data={data} filterValue={filterValue} />

      <PaymentsTable 
        data={data} 
        filterValue={filterValue} 
        loading={loading}
      />

      <CreatePaymentForm
        isOpen={isCreatePaymentOpen}
        onClose={() => setIsCreatePaymentOpen(false)}
        onSubmit={handleCreatePayment}
      />
    </div>
  );
};

export default PaymentsPage;