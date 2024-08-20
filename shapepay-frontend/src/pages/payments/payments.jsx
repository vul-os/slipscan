import React, { useState, useEffect, useContext, useCallback } from 'react';
import { addDays, endOfDay } from "date-fns";
import { Plus } from 'lucide-react';
import { supabase } from '../../services/supabaseClient';
import { Button } from "@/components/ui/button";
import { AuthContext } from '../../context/use-auth';
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
    to: endOfDay(new Date()),
  });
  const [filterValue, setFilterValue] = useState("");

  const fetchPaymentGroups = useCallback(async () => {
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
  }, [activeMerchantId, dateRange]);

  useEffect(() => {
    if (dateRange?.from && dateRange?.to) {
      fetchPaymentGroups();
    }
  }, [fetchPaymentGroups, dateRange]);

  useEffect(() => {
    const subscription = supabase
      .channel('payment_groups_changes')
      .on('postgres_changes', 
        { 
          event: '*', 
          schema: 'public', 
          table: 'payment_groups',
          filter: `merchant_id=eq.${activeMerchantId}`
        },
        (payload) => {
          console.log('Change received!', payload);
          fetchPaymentGroups();
        }
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [activeMerchantId, fetchPaymentGroups]);

  const handleCreatePayment = async (newPayment) => {
    try {
      // Implementation for creating a new payment
      console.log('Creating new payment:', newPayment);
      
      // After successfully creating the payment:
      setIsCreatePaymentOpen(false);
      // The table will update automatically due to the real-time subscription
    } catch (error) {
      console.error('Error creating payment:', error);
    }
  };

  return (
    <div className="container mx-auto px-2 sm:px-4 py-4 bg-gray-900 text-white">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold mb-4 sm:mb-0">Payments</h1>
        <Button onClick={() => setIsCreatePaymentOpen(true)} className="bg-blue-500 hover:bg-blue-600 w-full sm:w-auto">
          <Plus className="w-4 h-4 mr-2" /> New Payment
        </Button>
      </div>

      <div className="space-y-6">
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
      </div>

      <CreatePaymentForm
        isOpen={isCreatePaymentOpen}
        onClose={() => setIsCreatePaymentOpen(false)}
        onSubmit={handleCreatePayment}
      />
    </div>
  );
};

export default PaymentsPage;